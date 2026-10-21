import { promises as fs } from "node:fs";
import path from "node:path";
import { WINDOW_KINDS } from "./usageTelemetry.js";
import { rateLimitInfoFromEvent } from "./usageLimitDetector.js";

/**
 * T-0402: the USD-to-utilization-fraction conversion `admissionDecision.js`'s
 * `evaluateWindowAdmission` needs before a USD cost estimate can ever be compared against a
 * window's `utilization_fraction` budget (see that module's `convertUsdToWindowUnits`). Bump
 * this when the FITTING METHOD itself changes (e.g. a different pairing strategy); a re-fit with
 * the same method against newer evidence is a new `fitDate`/`sampleCount`, not a new version --
 * same convention as `costEstimator.js`'s `ESTIMATOR_VERSION`.
 */
export const CONVERSION_VERSION = "v1";

/**
 * Below this many independent rate samples, an empirical rate is too noisy to trust -- mirrors
 * `costEstimator.js`'s `MIN_SAMPLES_FOR_EMPIRICAL_ESTIMATE` (also 5), the project's existing
 * convention for "how much evidence before we call a fit real".
 */
export const MIN_SAMPLES_FOR_USABLE_CONVERSION = 5;

/**
 * Above this coefficient of variation (stddev / mean), the samples disagree too much for a single
 * point estimate to mean anything -- see docs/usd-utilization-conversion.md's citation of the
 * real spread this threshold was chosen against. 0.5 matches `costEstimator.js`'s own
 * `TYPE_PRIORS` uncertainty-to-value ratios (0.4-0.6 across every registered type), so a window's
 * conversion is held to the same tolerance the rest of this card set already treats as normal.
 */
export const MAX_COEFFICIENT_OF_VARIATION = 0.5;

/**
 * One rate sample per completed reset cycle (two or more measured readings sharing one
 * `resetsAt`), rather than per adjacent reading pair. Adjacent pairs are usually only 1-2
 * percentage points apart -- `utilization` is only ever reported to ~2 decimal places -- so
 * inverting a tiny, coarsely-quantized denominator amplifies noise enormously (see
 * docs/usd-utilization-conversion.md's side-by-side comparison: the real adjacent-pair fit has a
 * coefficient of variation near 0.9-1.0, the real per-cycle fit is 0.4). Spanning a whole reset
 * cycle (first reading after reset to last reading before the next one) keeps the same "only
 * ever a real utilization increase, against real recorded spend" contract while averaging the
 * quantization noise out over a much larger denominator.
 *
 * `readings` is this ONE window's own measured-and-timed readings (`{receivedAtMs, utilization,
 * resetsAt}`); `ledgerEntries` is every usage-ledger entry recorded anywhere on the board
 * (`{recordedAtMs, costUsd}`, `costUsd: null` for a censored/unknown-cost entry) -- the window's
 * rate-limit pool is global across every card, so a sample's spend is summed across ALL of them,
 * never scoped to one card.
 *
 * A cycle is dropped, never approximated, when: it has fewer than two readings (no increase to
 * measure); its utilization didn't increase (noise, or a reset landed mid-cycle); ANY ledger
 * entry inside its interval is censored (the true spend is only known to be `>=` the visible
 * subtotal, which would bias the rate low -- never silently treated as the whole spend); or the
 * known spend in its interval is non-positive (a zero/negative rate is never fabricated).
 */
/** Shared by `deriveRateSamplesForWindow` and `diagnoseCensoredCycles` so the two can never disagree about what counts as one reset cycle. */
function groupReadingsByResetCycle(readings) {
  const byResetCycle = new Map();
  for (const r of readings) {
    const key = String(r.resetsAt);
    if (!byResetCycle.has(key)) byResetCycle.set(key, []);
    byResetCycle.get(key).push(r);
  }
  return byResetCycle;
}

export function deriveRateSamplesForWindow({ readings, ledgerEntries }) {
  const byResetCycle = groupReadingsByResetCycle(readings);

  const samples = [];
  for (const cycleReadings of byResetCycle.values()) {
    if (cycleReadings.length < 2) continue;
    const sorted = [...cycleReadings].sort((a, b) => a.receivedAtMs - b.receivedAtMs);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const dUtil = last.utilization - first.utilization;
    if (!(dUtil > 0)) continue;

    let dUsd = 0;
    let censored = false;
    let ledgerEntryCount = 0;
    for (const entry of ledgerEntries) {
      if (typeof entry.recordedAtMs !== "number") continue;
      if (entry.recordedAtMs <= first.receivedAtMs || entry.recordedAtMs > last.receivedAtMs) continue;
      if (typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd)) {
        dUsd += entry.costUsd;
        ledgerEntryCount += 1;
      } else {
        censored = true;
      }
    }
    if (censored || !(dUsd > 0)) continue;

    samples.push({
      rate: dUsd / dUtil,
      dUtil,
      dUsd,
      readingCount: sorted.length,
      ledgerEntryCount,
      cycleStartMs: first.receivedAtMs,
      cycleEndMs: last.receivedAtMs
    });
  }
  return samples;
}

/**
 * T-0457: names exactly which reset cycles `deriveRateSamplesForWindow` dropped SPECIFICALLY
 * because a censored (`costUsd: null`) ledger entry fell inside their interval -- as opposed to a
 * cycle dropped for having fewer than two readings, no genuine utilization increase, or zero known
 * spend, none of which are a censoring problem. Conflating those would misrepresent how much of a
 * window's evidence gap is actually cost-data censoring versus something else (see
 * docs/usd-utilization-conversion.md's "origin of costUsd: null" section, which this function is
 * the re-derivable mechanism behind -- re-run it against any `runsDir` via this module's own scan
 * helpers whenever the evidence needs re-checking, instead of a one-off script).
 *
 * Shares `deriveRateSamplesForWindow`'s own cycle-eligibility rules (>=2 readings, a genuine
 * increase) so a cycle only ever appears here when censoring is the ONE AND ONLY reason it isn't
 * also a rate sample -- never double-reported as both.
 */
export function diagnoseCensoredCycles({ readings, ledgerEntries }) {
  const byResetCycle = groupReadingsByResetCycle(readings);
  const diagnostics = [];

  for (const [resetsAtKey, cycleReadings] of byResetCycle.entries()) {
    if (cycleReadings.length < 2) continue;
    const sorted = [...cycleReadings].sort((a, b) => a.receivedAtMs - b.receivedAtMs);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const dUtil = last.utilization - first.utilization;
    if (!(dUtil > 0)) continue;

    let censoredEntryCount = 0;
    let knownEntryCount = 0;
    for (const entry of ledgerEntries) {
      if (typeof entry.recordedAtMs !== "number") continue;
      if (entry.recordedAtMs <= first.receivedAtMs || entry.recordedAtMs > last.receivedAtMs) continue;
      if (typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd)) knownEntryCount += 1;
      else censoredEntryCount += 1;
    }
    if (censoredEntryCount === 0) continue;

    diagnostics.push({
      resetsAt: Number(resetsAtKey),
      cycleStartMs: first.receivedAtMs,
      cycleEndMs: last.receivedAtMs,
      readingCount: sorted.length,
      censoredEntryCount,
      knownEntryCount
    });
  }

  return diagnostics;
}

function median(sortedValues) {
  const n = sortedValues.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedValues[mid - 1] + sortedValues[mid]) / 2 : sortedValues[mid];
}

function standardDeviation(values, mean) {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * The minimum-evidence gate (spec of this card: "refuse to ship a rate it cannot justify, and say
 * so, rather than inventing one"). `samples` is `deriveRateSamplesForWindow`'s own output (or
 * anything carrying a `.rate`). Usable only when there are at least `minSamples` AND their
 * coefficient of variation (stddev / mean) is at most `maxCoefficientOfVariation` -- below either
 * bar, `usdPerUtilizationUnit` is `null`, never a number a caller could mistake for trustworthy.
 * The point estimate itself is the MEDIAN rate (robust to the single-outlier-cycle case real
 * evidence actually showed -- see docs/usd-utilization-conversion.md), not the mean.
 *
 * `candidateUsdPerUtilizationUnit` always carries the computed median even when `usable` is
 * `false` -- mirrors `costEstimator.js`'s `provisionalFitDiagnostic` pattern: the number isn't
 * hidden, it's just never exposed as something a caller may actually use for admission.
 */
export function fitConversionFromSamples(samples, { minSamples = MIN_SAMPLES_FOR_USABLE_CONVERSION, maxCoefficientOfVariation = MAX_COEFFICIENT_OF_VARIATION } = {}) {
  const sampleCount = samples.length;
  if (sampleCount === 0) {
    return { usable: false, reason: "no rate samples recorded", sampleCount, usdPerUtilizationUnit: null, candidateUsdPerUtilizationUnit: null, mean: null, sd: null, cv: null, min: null, max: null };
  }

  const rates = samples.map((s) => s.rate);
  const sorted = [...rates].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sampleCount;
  const sd = standardDeviation(sorted, mean);
  const cv = mean === 0 ? Infinity : sd / mean;
  const candidate = median(sorted);

  if (sampleCount < minSamples) {
    return {
      usable: false,
      reason: `only ${sampleCount} rate sample(s) recorded, below the minimum of ${minSamples} this conversion requires to be trusted`,
      sampleCount,
      usdPerUtilizationUnit: null,
      candidateUsdPerUtilizationUnit: candidate,
      mean,
      sd,
      cv,
      min: sorted[0],
      max: sorted[sorted.length - 1]
    };
  }

  if (cv > maxCoefficientOfVariation) {
    return {
      usable: false,
      reason: `rate samples disagree too much to trust a single rate (coefficient of variation ${cv.toFixed(3)} exceeds the max of ${maxCoefficientOfVariation})`,
      sampleCount,
      usdPerUtilizationUnit: null,
      candidateUsdPerUtilizationUnit: candidate,
      mean,
      sd,
      cv,
      min: sorted[0],
      max: sorted[sorted.length - 1]
    };
  }

  return {
    usable: true,
    reason: null,
    sampleCount,
    usdPerUtilizationUnit: candidate,
    candidateUsdPerUtilizationUnit: candidate,
    mean,
    sd,
    cv,
    min: sorted[0],
    max: sorted[sorted.length - 1]
  };
}

const LEDGER_REVISION_RE = /^(.*\.usage\.json)\.rev(\d+)-(\d+)\.json$/;

/** Every usage-ledger entry anywhere in `runsDir`, deduped to the freshest revision per canonical key -- across every card, since a window's rate-limit pool is shared by all of them. */
async function scanLedgerEntries({ runsDir, readdirFn, readFileFn }) {
  let names;
  try {
    names = await readdirFn(runsDir);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }

  const bestByKey = new Map();
  for (const name of names) {
    const match = LEDGER_REVISION_RE.exec(name);
    if (!match) continue;
    let raw;
    try {
      raw = JSON.parse(await readFileFn(path.join(runsDir, name), "utf8"));
    } catch {
      continue; // malformed/unreadable -- skip rather than throw, same posture as usageLedger.js
    }
    const revision = raw && raw.revision && typeof raw.revision.epoch === "number" ? raw.revision : { epoch: Number(match[2]), sequence: Number(match[3]) };
    const key = match[1];
    const existing = bestByKey.get(key);
    if (!existing || revision.epoch > existing.revision.epoch || (revision.epoch === existing.revision.epoch && revision.sequence > existing.revision.sequence)) {
      bestByKey.set(key, { revision, entry: raw });
    }
  }

  return Array.from(bestByKey.values())
    .map(({ entry }) => ({
      recordedAtMs: typeof entry.recordedAt === "string" ? Date.parse(entry.recordedAt) : NaN,
      costUsd: typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd) ? entry.costUsd : null
    }))
    .filter((e) => Number.isFinite(e.recordedAtMs));
}

/**
 * Every MEASURED, TIMED `rate_limit_event` reading for one window kind, across every
 * `*.jsonl` run log in `runsDir` -- unlike `usageTelemetry.js`'s `readWindowUsage` (which only
 * ever wants the single newest one), this derivation needs the whole history to pair readings
 * within a reset cycle. An event with no numeric `utilization` (a status-only reading) or no
 * `receivedAtMs` (untrusted timing -- see usageTelemetry.js's own rule) is never used to fit a
 * rate; both would otherwise silently distort Δutilization or Δt.
 */
async function scanRateLimitReadings({ runsDir, windowKind, readdirFn, readFileFn }) {
  let names;
  try {
    names = await readdirFn(runsDir);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }

  const readings = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    let raw;
    try {
      raw = await readFileFn(path.join(runsDir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const info = rateLimitInfoFromEvent(event);
      if (!info || info.rateLimitType !== windowKind) continue;
      if (typeof info.utilization !== "number" || !Number.isFinite(info.utilization)) continue;
      if (typeof event.receivedAtMs !== "number" || !Number.isFinite(event.receivedAtMs)) continue;
      readings.push({ receivedAtMs: event.receivedAtMs, utilization: info.utilization, resetsAt: info.resetsAt });
    }
  }
  return readings;
}

/**
 * Re-derives the conversion table directly from `runsDir`'s own recorded evidence -- the same
 * pipeline (`scanRateLimitReadings` + `scanLedgerEntries` -> `deriveRateSamplesForWindow` ->
 * `fitConversionFromSamples`) that produced the committed `DEFAULT_USD_UTILIZATION_CONVERSION`
 * below, callable again later against the live board's `tasks/.runs/` as more evidence
 * accumulates (see docs/usd-utilization-conversion.md's "how to re-fit" section) -- a re-fit
 * never requires a code change, only a new `fitDate` and a review of the result.
 */
export async function deriveUsdUtilizationConversionFromRuns({
  runsDir,
  version = CONVERSION_VERSION,
  fitDate,
  minSamples = MIN_SAMPLES_FOR_USABLE_CONVERSION,
  maxCoefficientOfVariation = MAX_COEFFICIENT_OF_VARIATION,
  readdirFn = fs.readdir,
  readFileFn = fs.readFile
}) {
  const ledgerEntries = await scanLedgerEntries({ runsDir, readdirFn, readFileFn });

  const windows = {};
  for (const windowKind of WINDOW_KINDS) {
    const readings = await scanRateLimitReadings({ runsDir, windowKind, readdirFn, readFileFn });
    const samples = deriveRateSamplesForWindow({ readings, ledgerEntries });
    const fit = fitConversionFromSamples(samples, { minSamples, maxCoefficientOfVariation });
    windows[windowKind] = {
      ...fit,
      version,
      fitDate,
      method: "reset-cycle-aggregate",
      windowRangeStart: samples.length ? new Date(Math.min(...samples.map((s) => s.cycleStartMs))).toISOString() : null,
      windowRangeEnd: samples.length ? new Date(Math.max(...samples.map((s) => s.cycleEndMs))).toISOString() : null
    };
  }
  return { version, fitDate, windows };
}

/**
 * The committed, versioned conversion (spec: "at minimum usdPerUtilizationUnit per window kind,
 * carrying a version identifier and the date/window range of the evidence it was fitted from").
 * Frozen here rather than re-derived at board startup because the real evidence
 * (`tasks/.runs/*.jsonl` + usage-ledger entries) is a runtime-only, gitignored directory that
 * starts empty in a fresh worktree or CI checkout -- exactly like `docs/usage-telemetry.md`'s own
 * provenance note for why ITS claims are cited rather than asserted by a test that reads the real
 * directory. This table is the one-time, real result of
 * `deriveUsdUtilizationConversionFromRuns({ runsDir: "<repo-root>/tasks/.runs" })`, run on
 * 2026-10-16 -- full citation, method comparison, and the real sample tables for both windows are
 * in docs/usd-utilization-conversion.md.
 *
 * `five_hour` clears both bars (5 reset-cycle samples, coefficient of variation ~0.40) and ships
 * as usable. `seven_day` does NOT -- exactly one reset cycle in the real history produced a usable
 * rate sample, nowhere near `MIN_SAMPLES_FOR_USABLE_CONVERSION`. This is NOT a reading-count
 * shortage: several later weekly cycles do have two or more measured readings, but
 * `deriveRateSamplesForWindow`'s all-or-nothing censoring rule drops a candidate cycle outright
 * when ANY usage-ledger entry inside its interval is censored (`costUsd: null`), and the real
 * history has enough censored entries landing inside those later cycles that none of them survives
 * to become a second sample -- a censoring-driven gap, not a reading-count gap (see
 * `docs/usd-utilization-conversion.md`'s "seven_day -- not usable" section for the full citation).
 * This is a genuine per-window disagreement in how much evidence exists, not a shared rate forced
 * onto both: `seven_day` stays `usable: false` until a later re-fit (the mechanism above, not a
 * code change) accumulates enough reset cycles whose full interval's usage-ledger spend is
 * uncensored.
 */
export const DEFAULT_USD_UTILIZATION_CONVERSION = Object.freeze({
  version: CONVERSION_VERSION,
  fitDate: "2026-10-16",
  windows: Object.freeze({
    five_hour: Object.freeze({
      usable: true,
      reason: null,
      sampleCount: 5,
      usdPerUtilizationUnit: 77.45769000000003,
      candidateUsdPerUtilizationUnit: 77.45769000000003,
      mean: 86.41720572222225,
      sd: 34.75204141309151,
      cv: 0.4021426187372661,
      min: 55.147420000000004,
      max: 144.3804077777778,
      version: CONVERSION_VERSION,
      fitDate: "2026-10-16",
      method: "reset-cycle-aggregate",
      windowRangeStart: "2026-09-17T20:52:57.940Z",
      windowRangeEnd: "2026-09-30T16:10:45.255Z"
    }),
    seven_day: Object.freeze({
      usable: false,
      reason: "only 1 rate sample(s) recorded, below the minimum of 5 this conversion requires to be trusted",
      sampleCount: 1,
      usdPerUtilizationUnit: null,
      candidateUsdPerUtilizationUnit: 376.4974330000001,
      mean: 376.4974330000001,
      sd: 0,
      cv: 0,
      min: 376.4974330000001,
      max: 376.4974330000001,
      version: CONVERSION_VERSION,
      fitDate: "2026-10-16",
      method: "reset-cycle-aggregate",
      windowRangeStart: "2026-09-12T23:47:01.296Z",
      windowRangeEnd: "2026-09-15T08:51:03.630Z"
    })
  })
});

/**
 * Narrows a `deriveUsdUtilizationConversionFromRuns`/`DEFAULT_USD_UTILIZATION_CONVERSION`-shaped
 * table into the `{five_hour, seven_day}` shape `admissionDecision.js`'s `evaluateAdmission`
 * expects for its own `unitConversion` argument -- `null` for any window that isn't `usable` or
 * doesn't carry a positive, finite rate, so a malformed or withheld entry can never slip through
 * as if it were comparable (the fail-safe `evaluateWindowAdmission` already applies is defense in
 * depth, not the only guard).
 */
export function resolveUnitConversionForAdmission(table = DEFAULT_USD_UTILIZATION_CONVERSION) {
  const resolved = {};
  for (const windowKind of WINDOW_KINDS) {
    const entry = table?.windows?.[windowKind];
    resolved[windowKind] =
      entry && entry.usable && typeof entry.usdPerUtilizationUnit === "number" && Number.isFinite(entry.usdPerUtilizationUnit) && entry.usdPerUtilizationUnit > 0
        ? { usdPerUtilizationUnit: entry.usdPerUtilizationUnit, sampleCount: entry.sampleCount, fitDate: entry.fitDate, version: entry.version }
        : null;
  }
  return resolved;
}
