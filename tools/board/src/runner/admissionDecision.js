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
  UNITS_NOT_COMPARABLE: "units_not_comparable"
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

  return {
    windowKind,
    admitted,
    holdReason: null,
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
 * Evaluates every window (`WINDOW_KINDS`, currently `five_hour`/`seven_day`) independently and
 * combines them: admitted only when EVERY window admits, so a healthy window can never mask an
 * exhausted or unreadable one (spec §4). `config` is the `loadAdmissionConfigFromEnv`-shaped
 * object (per-window `externalBurnAllowance`/`uncertaintyReserve`); this function narrows it to
 * each window's own flat values before calling `evaluateWindowAdmission`.
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
      unitConversion
    });
  }

  const decisions = Object.values(windows);
  const admitted = decisions.every((d) => d.admitted === true) ? true : decisions.some((d) => d.admitted === false) ? false : null;

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
