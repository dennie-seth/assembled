import { READING_STATUS, WINDOW_KINDS } from "./usageTelemetry.js";

/**
 * WIP gate T-D (spec §4): the per-window admission formula, evaluated independently for
 * `five_hour` and `seven_day` so a healthy reading in one window can never mask an exhausted
 * other window (spec §4's own requirement, and the 2026-09-12 design note's elapsed-reset /
 * status-only cases). Every branch that would otherwise have to guess returns an explicit hold
 * reason instead -- never a fabricated admit and never a fabricated refuse.
 */
export const HOLD_REASON = Object.freeze({
  NO_MEASURED_READING: "no_measured_window_reading",
  ESTIMATE_UNKNOWN: "estimate_unknown",
  UNITS_NOT_COMPARABLE: "units_not_comparable",
  RESERVED_COST_UNKNOWN: "reserved_cost_unknown",
  // T-0379: names a refusal that can NEVER become an admit, regardless of how idle the window
  // gets -- distinct from an ordinary `admitted: false` (which just means "not right now"). Only
  // set when the estimate is comparable to begin with (a measured reading, a known estimate, a
  // known reserved cost, and comparable units); see `evaluateWindowAdmission`.
  OVERSIZED_ESTIMATE_NEVER_FITS: "oversized_estimate_never_fits"
});

/** The unit every window's `readWindowUsage` reading is expressed in -- see usageTelemetry.js. */
const WINDOW_CAPACITY_UNIT = "utilization_fraction";

function holdDecision(windowKind, holdReason, extra = {}) {
  return {
    windowKind,
    admitted: null,
    holdReason,
    observedRemainingCapacity: null,
    reservedUnspentCost: null,
    predictedRemainingCostUpperBound: null,
    budget: null,
    dial: null,
    ...extra
  };
}

/**
 * `estimate` counts as a known cost only when its `value` is a real, finite number (Codex
 * WIP-gate constraint: "an estimate classified indeterminate or large_hold_for_sizing, or with a
 * null value, is carried into the admission decision ... as an explicit unknown/hold -- never
 * coerced to a zero cost or to unlimited capacity").
 */
function estimateIsKnown(estimate) {
  return Boolean(estimate) && typeof estimate.value === "number" && Number.isFinite(estimate.value);
}

/**
 * Converts a USD amount into `WINDOW_CAPACITY_UNIT`s via a versioned, recorded-evidence
 * conversion (spec §4 / Codex constraint 4: "unless a conversion is derived from recorded
 * evidence (versioned, with its sample count and fit date) the per-window comparison returns an
 * explicit units-not-comparable hold"). `unitConversion` is `null` by default everywhere in this
 * card -- no such fit has been built yet -- so every USD estimate hits `UNITS_NOT_COMPARABLE`
 * until a later card derives and versions one.
 */
function convertUsdToWindowUnits(usdAmount, unitConversion) {
  if (!unitConversion || typeof unitConversion.usdPerUtilizationUnit !== "number" || unitConversion.usdPerUtilizationUnit <= 0) {
    return null;
  }
  return usdAmount / unitConversion.usdPerUtilizationUnit;
}

/**
 * Evaluates spec §4's formula for ONE window:
 *
 *   predicted_remaining_cost_upper_bound
 *       <= dial * max(0, observed_remaining_capacity - reserved_unspent_cost
 *                        - expected_external_burn_allowance - uncertainty_reserve)
 *
 * `reading` is one window's `readWindowUsage`-shaped classification; `estimate` is T-0369's
 * `estimateCost`-shaped prediction (USD); `reservedUnspentCostUsd` is the shared launch-boundary
 * reservation ledger's current unspent total (USD, see `launchReservation.js`); `config` carries
 * this window's `externalBurnAllowance`/`uncertaintyReserve` (both in `WINDOW_CAPACITY_UNIT`s)
 * and the overall `dial`. `unitConversion`, when supplied, is the versioned USD-per-utilization-
 * unit rate a later card derives from recorded evidence -- omitted (the default everywhere
 * today), every USD estimate is `UNITS_NOT_COMPARABLE` rather than silently assumed convertible.
 */
export function evaluateWindowAdmission({ windowKind, reading, estimate, reservedUnspentCostUsd = 0, config, unitConversion = null }) {
  if (!reading || reading.classification !== READING_STATUS.MEASURED || typeof reading.utilization !== "number") {
    return holdDecision(windowKind, HOLD_REASON.NO_MEASURED_READING, { reading: reading?.classification ?? null });
  }

  if (!estimateIsKnown(estimate)) {
    return holdDecision(windowKind, HOLD_REASON.ESTIMATE_UNKNOWN, { estimateClassification: estimate?.classification ?? null });
  }

  // T-0370 fix round (Codex review, finding 1/6): `reservedUnspentCostUsd` is only ever a real
  // number when both the active-reservation pool AND every active reservation's own ledger spend
  // were readable. A caller that couldn't determine one passes `null` explicitly (never a
  // fabricated `0`, which would silently under-count other in-flight launches' consumption) --
  // that is an explicit hold, same as an unknown estimate or an unmeasured window.
  if (typeof reservedUnspentCostUsd !== "number" || !Number.isFinite(reservedUnspentCostUsd)) {
    return holdDecision(windowKind, HOLD_REASON.RESERVED_COST_UNKNOWN);
  }

  const predictedRemainingCostUpperBound =
    estimate.unit === WINDOW_CAPACITY_UNIT ? estimate.value : convertUsdToWindowUnits(estimate.value, unitConversion);
  const reservedUnspentCost =
    estimate.unit === WINDOW_CAPACITY_UNIT || reservedUnspentCostUsd === 0
      ? reservedUnspentCostUsd
      : convertUsdToWindowUnits(reservedUnspentCostUsd, unitConversion);

  if (predictedRemainingCostUpperBound === null || reservedUnspentCost === null) {
    return holdDecision(windowKind, HOLD_REASON.UNITS_NOT_COMPARABLE, { estimateUnit: estimate.unit, windowUnit: WINDOW_CAPACITY_UNIT });
  }

  const observedRemainingCapacity = 1 - reading.utilization;
  const externalBurnAllowance = config.externalBurnAllowance ?? 0;
  const uncertaintyReserve = config.uncertaintyReserve ?? 0;
  const dial = config.dial ?? 1;

  const budget = Math.max(0, observedRemainingCapacity - reservedUnspentCost - externalBurnAllowance - uncertaintyReserve);
  const admitted = predictedRemainingCostUpperBound <= dial * budget;

  // T-0379: a refusal is permanent -- never admittable by this window becoming more idle -- when
  // it would still be refused at the theoretical maximum headroom (utilization 0, i.e.
  // `observedRemainingCapacity` at its ceiling of 1). Only meaningful when `admitted` is already
  // `false`; an admit is never oversized.
  let holdReason = null;
  if (!admitted) {
    const maxPossibleBudget = Math.max(0, 1 - reservedUnspentCost - externalBurnAllowance - uncertaintyReserve);
    if (predictedRemainingCostUpperBound > dial * maxPossibleBudget) {
      holdReason = HOLD_REASON.OVERSIZED_ESTIMATE_NEVER_FITS;
    }
  }

  return {
    windowKind,
    admitted,
    holdReason,
    observedRemainingCapacity,
    reservedUnspentCost,
    externalBurnAllowance,
    uncertaintyReserve,
    dial,
    budget,
    predictedRemainingCostUpperBound
  };
}

/**
 * Evaluates every window (`WINDOW_KINDS`, currently `five_hour`/`seven_day`) independently, then
 * combines them (spec §4's "a healthy window can never mask an exhausted or unreadable one",
 * still true below -- see the T-0402 round 2 carve-out). `config` is the
 * `loadAdmissionConfigFromEnv`-shaped object (per-window `externalBurnAllowance`/
 * `uncertaintyReserve`); this function narrows it to each window's own flat values before calling
 * `evaluateWindowAdmission`.
 *
 * `unitConversion` (T-0402) is likewise keyed per window -- `{five_hour, seven_day}`, each either
 * a `usdUtilizationConversion.js`-shaped conversion or `null` -- NEVER one flat rate shared across
 * both. The two windows are different pools (different sizes, different reset cadence) and the
 * real recorded evidence (`docs/usd-utilization-conversion.md`) already shows one window can
 * clear the minimum-evidence bar while the other doesn't; narrowing per window here is what lets
 * a window with a usable derived rate get a genuine admit/hold while a window with none (or
 * one too noisy to trust) still, correctly, holds `UNITS_NOT_COMPARABLE` on its own.
 *
 * T-0402 round 2 (reviewer FAIL on acceptance criterion 3): the ORIGINAL combination here --
 * admitted only when literally every window admits -- made the aggregate verdict stuck at `null`
 * for every real auto launch, through the real default conversion, forever: `seven_day`'s real
 * recorded history has exactly one reset-cycle sample, nowhere near
 * `MIN_SAMPLES_FOR_USABLE_CONVERSION`, so it can never be anything but `UNITS_NOT_COMPARABLE`
 * until a later re-fit accumulates more evidence (not a code change -- see
 * `usdUtilizationConversion.js`). Holding every launch forever over a single window's documented
 * EVIDENCE GAP would reproduce the exact problem this card exists to fix, under a different name.
 * So `UNITS_NOT_COMPARABLE` specifically is treated as a non-veto: it never masks a GENUINE
 * admit from a window that DOES have comparable evidence, and it never hides itself either -- it
 * still appears, unchanged, on that window's own `windows[windowKind]` entry for a human (or
 * `docs/wip-gate-admission.md`'s runbook) to see. This is deliberately narrower than "any
 * unknown hold doesn't veto": every OTHER hold reason
 * (`NO_MEASURED_READING`/`ESTIMATE_UNKNOWN`/`RESERVED_COST_UNKNOWN`) represents genuinely missing
 * REQUIRED data for that launch, not a known, versioned coverage gap, and still vetoes exactly as
 * before. An actual measured `false` in ANY window (comparable or not) still vetoes unconditionally
 * -- the non-veto only ever softens "we don't know yet", never "no". And when NO window has a
 * usable conversion at all, the aggregate still falls back to the original fail-safe (`null`,
 * never a fabricated admit) -- unchanged from before this card shipped any conversion.
 */
export function evaluateAdmission({ telemetryReadings, estimate, reservedUnspentCostUsd = 0, config, unitConversion = null }) {
  const windows = {};
  for (const windowKind of WINDOW_KINDS) {
    windows[windowKind] = evaluateWindowAdmission({
      windowKind,
      reading: telemetryReadings[windowKind],
      estimate,
      reservedUnspentCostUsd,
      config: {
        dial: config.dial,
        externalBurnAllowance: config.externalBurnAllowance?.[windowKind],
        uncertaintyReserve: config.uncertaintyReserve?.[windowKind]
      },
      unitConversion: unitConversion?.[windowKind] ?? null
    });
  }

  const decisions = Object.values(windows);
  const anyFalse = decisions.some((d) => d.admitted === false);
  const anyNonUnitsHold = decisions.some((d) => d.admitted === null && d.holdReason !== HOLD_REASON.UNITS_NOT_COMPARABLE);
  const anyTrue = decisions.some((d) => d.admitted === true);

  // A real, measured shortage always wins. Otherwise, any hold reason OTHER than the documented
  // units-evidence gap is still an unresolved unknown and still holds the aggregate. Otherwise,
  // admitted only once at least one window actually said yes -- never true purely because every
  // window happened to be UNITS_NOT_COMPARABLE (that is the original, unchanged fail-safe).
  const admitted = anyFalse ? false : anyNonUnitsHold ? null : anyTrue ? true : null;

  return { admitted, windows };
}

const ENABLE_VALUES = new Set(["1", "true", "on", "yes"]);

/**
 * WIP_GATE_ENFORCEMENT_ENABLED env var: default OFF (spec's own phasing -- "enforcement is a
 * separate, later decision ... out of scope for every card in this set"). This card never
 * enables it on the live board; flipping it is Dennie's call, later.
 */
export function admissionEnforcementEnabledFromEnv() {
  return ENABLE_VALUES.has((process.env.WIP_GATE_ENFORCEMENT_ENABLED ?? "").toLowerCase());
}

/** Conservative defaults (spec §6): a modest floor set aside for manual/other-host consumers and for estimate uncertainty, per window, in `WINDOW_CAPACITY_UNIT`s. */
export const DEFAULT_ADMISSION_CONFIG = Object.freeze({
  dial: 1,
  externalBurnAllowance: Object.freeze({ five_hour: 0.05, seven_day: 0.05 }),
  uncertaintyReserve: Object.freeze({ five_hour: 0.05, seven_day: 0.05 })
});

function parseFraction(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Loads the admission config (spec §6: "kept distinct" -- external burn allowance and
 * uncertainty reserve are separate configurable values per window, plus the overall dial).
 * Every explicit override is logged (spec: "overrides are explicit and logged"); an unset or
 * unparseable env var silently falls back to `DEFAULT_ADMISSION_CONFIG`'s value instead, since
 * that is not an override at all.
 */
export function loadAdmissionConfigFromEnv({ logger = console } = {}) {
  const overrides = [];
  const cfg = {
    dial: DEFAULT_ADMISSION_CONFIG.dial,
    externalBurnAllowance: { ...DEFAULT_ADMISSION_CONFIG.externalBurnAllowance },
    uncertaintyReserve: { ...DEFAULT_ADMISSION_CONFIG.uncertaintyReserve }
  };

  const dialRaw = process.env.WIP_GATE_DIAL;
  if (dialRaw !== undefined && dialRaw !== "") {
    const parsed = parseFraction(dialRaw);
    if (parsed !== null) {
      cfg.dial = parsed;
      overrides.push(`WIP_GATE_DIAL=${parsed}`);
    }
  }

  for (const windowKind of WINDOW_KINDS) {
    const suffix = windowKind.toUpperCase();
    const allowanceKey = `WIP_GATE_EXTERNAL_BURN_ALLOWANCE_${suffix}`;
    const allowanceRaw = process.env[allowanceKey];
    if (allowanceRaw !== undefined && allowanceRaw !== "") {
      const parsed = parseFraction(allowanceRaw);
      if (parsed !== null) {
        cfg.externalBurnAllowance[windowKind] = parsed;
        overrides.push(`${allowanceKey}=${parsed}`);
      }
    }

    const uncertaintyKey = `WIP_GATE_UNCERTAINTY_RESERVE_${suffix}`;
    const uncertaintyRaw = process.env[uncertaintyKey];
    if (uncertaintyRaw !== undefined && uncertaintyRaw !== "") {
      const parsed = parseFraction(uncertaintyRaw);
      if (parsed !== null) {
        cfg.uncertaintyReserve[windowKind] = parsed;
        overrides.push(`${uncertaintyKey}=${parsed}`);
      }
    }
  }

  for (const override of overrides) {
    logger.log(`wip-gate admission: explicit config override -- ${override}`);
  }

  return cfg;
}
