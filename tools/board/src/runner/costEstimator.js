import { UsageLedgerReadIndeterminateError, listCardUsageEntries } from "./usageLedger.js";

/**
 * Spec §2/§7 (T-C, WIP-gate set): a stored cost estimate is a number **with units**, plus
 * `estimateSource`, `estimatorVersion`, and an explicit uncertainty measure -- never conflated
 * with a human `cost_band` (that's a separate, optional field elsewhere; this module never emits
 * one). Bump this whenever the estimation method itself changes, not on every re-fit -- a re-fit
 * with the same method is a new `fitDate`/`sampleCounts`, not a new version.
 */
export const ESTIMATOR_VERSION = "v1";

/** Coverage, not average (spec §2): the upper quantile this estimator targets by default. */
export const DEFAULT_COVERAGE_TARGET = 0.9;

/**
 * Below this many numeric (exact + censored) observations for a type, the empirical quantile is
 * too noisy to trust -- fall back to the conservative prior instead (spec §2 "Priors").
 */
export const MIN_SAMPLES_FOR_EMPIRICAL_ESTIMATE = 5;

export const ESTIMATE_SOURCE = Object.freeze({
  EMPIRICAL: "empirical_quantile",
  PRIOR: "type_prior",
  UNKNOWN_HOLD: "unknown_hold_for_sizing"
});

/**
 * Conservative type priors (spec §2): used verbatim whenever a type has too few samples to fit
 * empirically. Deliberately on the high side -- an overestimate wastes headroom, an underestimate
 * is exactly the failure mode this whole card set exists to stop.
 */
export const TYPE_PRIORS = Object.freeze({
  "infra-small": Object.freeze({ value: 0.5, unit: "usd", uncertainty: 0.25 }),
  "infra-large": Object.freeze({ value: 2.0, unit: "usd", uncertainty: 1.0 }),
  "asset-GPU": Object.freeze({ value: 5.0, unit: "usd", uncertainty: 3.0 }),
  review: Object.freeze({ value: 0.75, unit: "usd", uncertainty: 0.35 }),
  "board-loop-fix": Object.freeze({ value: 1.5, unit: "usd", uncertainty: 0.75 })
});

/**
 * Sentinel for "no estimate and no prior" (spec §2): fail safe, never a numeric guess. A caller
 * must treat this as "large / hold for sizing", not as "zero cost" or "no data available".
 */
function holdForSizingEstimate() {
  return {
    value: null,
    unit: "usd",
    estimateSource: ESTIMATE_SOURCE.UNKNOWN_HOLD,
    estimatorVersion: ESTIMATOR_VERSION,
    uncertainty: null,
    classification: "large_hold_for_sizing"
  };
}

/**
 * Converts one usage-ledger attempt entry (`recordAttemptUsage`'s own shape: `costUsd`,
 * `complete`) into a calibration observation. `complete === false` (crashed/cancelled/
 * phase-timeout/quota-stop-mid-flight) means the true cost may still be higher than whatever was
 * recorded -- a censored LOWER bound, never a finished figure (spec §2 "Censored observations").
 * A `complete === true` entry whose own `costUsd` is `null` (usageLedger's documented "valid
 * result event with no total_cost_usd figure" case) is likewise censored, not a measured zero --
 * "complete" describes the attempt's lifecycle, not whether its cost was ever actually observed.
 */
export function observationFromAttemptEntry(entry) {
  const hasKnownCost = typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd);
  if (entry.complete === true && hasKnownCost) {
    return { censored: false, costUsd: entry.costUsd };
  }
  return { censored: true, lowerBoundUsd: hasKnownCost ? entry.costUsd : 0 };
}

/**
 * Converts a `sumEntries`-shaped aggregate (`attemptTotal`/`executionTotal`/`cardCycleTotal`) into
 * a calibration observation (T-0367 consumer contract 2, Codex review 0913, 2026-09-13). An
 * aggregate with any `unknownCostEntries` reports `costUsd: null` by construction -- that must
 * become a censored observation at `knownCostUsd` (the true total is *at least* that subtotal,
 * never presented as the whole measured cost), never a measured `0` and never smaller than the
 * known subtotal.
 */
export function observationFromAggregate(aggregate) {
  if (aggregate.unknownCostEntries > 0 || typeof aggregate.costUsd !== "number") {
    return { censored: true, lowerBoundUsd: typeof aggregate.knownCostUsd === "number" ? aggregate.knownCostUsd : 0 };
  }
  return { censored: false, costUsd: aggregate.costUsd };
}

function observationValue(observation) {
  return observation.censored ? observation.lowerBoundUsd : observation.costUsd;
}

/** Linear-interpolation percentile over a pre-sorted ascending array (numpy's default method). */
function quantileOf(sortedValues, q) {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const pos = q * (sortedValues.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sortedValues[lower];
  const frac = pos - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * frac;
}

function standardDeviation(values, mean) {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Fits one type's cost estimate from its calibration observations (spec §2/§7). Coverage, not
 * average: the reported value is an upper quantile (`coverageTarget`, default 0.9) PLUS an
 * uncertainty margin -- never a plain mean, and never silently dropping censored (lower-bound)
 * observations from the pool that determines that quantile. Falls back to `TYPE_PRIORS[type]`
 * under `MIN_SAMPLES_FOR_EMPIRICAL_ESTIMATE`, and to the fail-safe hold-for-sizing sentinel when
 * neither empirical data nor a registered prior exists for `type`.
 */
export function estimateCost({ type, observations, coverageTarget = DEFAULT_COVERAGE_TARGET }) {
  const censoredCount = observations.filter((o) => o.censored).length;
  const sampleCount = observations.length;

  if (sampleCount < MIN_SAMPLES_FOR_EMPIRICAL_ESTIMATE) {
    const prior = TYPE_PRIORS[type];
    if (!prior) return holdForSizingEstimate();
    return {
      value: prior.value,
      unit: prior.unit,
      estimateSource: ESTIMATE_SOURCE.PRIOR,
      estimatorVersion: ESTIMATOR_VERSION,
      coverageTarget,
      uncertainty: { measure: "prior_fixed", value: prior.uncertainty },
      sampleCount,
      censoredCount,
      classification: "prior"
    };
  }

  const values = observations.map(observationValue).sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const stddevValue = standardDeviation(values, mean);
  const quantileValue = quantileOf(values, coverageTarget);
  const estimateValue = quantileValue + stddevValue;

  return {
    value: estimateValue,
    unit: "usd",
    estimateSource: ESTIMATE_SOURCE.EMPIRICAL,
    estimatorVersion: ESTIMATOR_VERSION,
    coverageTarget,
    quantileValue,
    uncertainty: { measure: "stddev", value: stddevValue, z: 1 },
    sampleCount,
    censoredCount,
    classification: "empirical"
  };
}

/**
 * Measures how often observed cost exceeded a given estimate (spec §2: "measure how often runs
 * exceed it", not just assert a coverage target and move on). An exact observation exceeds when
 * its known cost is greater than the estimate. A censored (lower-bound) observation can only ever
 * be COUNTED as a proven overrun (its lower bound alone already exceeds the estimate) -- it is
 * never counted as a proven non-overrun, since its true cost is unknown and may still be higher.
 * `evaluated` therefore excludes censored observations that didn't already prove an overrun,
 * rather than ever guessing they came in under the estimate.
 */
export function measureCoverage(observations, estimate) {
  let evaluated = 0;
  let exceeded = 0;
  for (const observation of observations) {
    if (!observation.censored) {
      evaluated += 1;
      if (observation.costUsd > estimate.value) exceeded += 1;
    } else if (observation.lowerBoundUsd > estimate.value) {
      evaluated += 1;
      exceeded += 1;
    }
  }
  return { evaluated, exceeded, fraction: evaluated === 0 ? null : exceeded / evaluated };
}

/**
 * Builds one versioned, dated calibration table across every type (spec §7 "Cadence"): version
 * the estimator/table with sample counts and fit dates so a later reader can tell which run of
 * calibration produced which numbers, and whether an overrun/coverage criterion has since been
 * met for raising any dial (a decision this card never makes itself).
 */
export function buildCostEstimatorTable({ typeSamples, fitDate, estimatorVersion = ESTIMATOR_VERSION, coverageTarget = DEFAULT_COVERAGE_TARGET }) {
  const sampleCounts = {};
  const types = {};
  for (const [type, observations] of Object.entries(typeSamples)) {
    sampleCounts[type] = observations.length;
    types[type] = estimateCost({ type, observations, coverageTarget });
  }
  return { estimatorVersion, fitDate, coverageTarget, sampleCounts, types };
}

/**
 * Reads every card's usage-ledger history to build the pool of calibration observations
 * (T-0367 consumer contract 1, Codex review 0913, 2026-09-13). A card whose ledger read throws
 * `UsageLedgerReadIndeterminateError` contributes ZERO observations from itself but is named in
 * `indeterminateCardIds` -- an explicit, visible "we don't know" that a caller must never confuse
 * with "this card has no usage" (which would silently and wrongly shrink the calibration pool).
 * One card's indeterminate read never aborts collection for the rest of the pool.
 */
export async function collectObservationsFromLedger({ runsDir, cardIds, listCardUsageEntriesFn = listCardUsageEntries }) {
  const observations = [];
  const indeterminateCardIds = [];
  for (const cardId of cardIds) {
    let entries;
    try {
      entries = await listCardUsageEntriesFn({ runsDir, cardId });
    } catch (err) {
      if (err instanceof UsageLedgerReadIndeterminateError) {
        indeterminateCardIds.push(cardId);
        continue;
      }
      throw err;
    }
    for (const entry of entries) {
      observations.push(observationFromAttemptEntry(entry));
    }
  }
  return { observations, indeterminateCardIds };
}

/**
 * Builds one weekly calibration summary (spec §7 "Cadence": "collect continuously, publish
 * weekly") straight from continuously collected ledger data -- the concrete link acceptance 5
 * requires between "continuously collected" (`collectObservationsFromLedger`, called once per
 * type here) and "a weekly calibration summary" (`buildCostEstimatorTable`'s versioned,
 * sample-counted, dated table). Each type's `indeterminateCardIds` are reported alongside its
 * sample count -- never silently folded into a smaller-but-confident pool -- and each type's
 * estimate carries its own `measureCoverage` result, so "reports the measured fraction of runs
 * that exceeded their estimate" (acceptance 2) is something this summary actually does, not only
 * something `measureCoverage` could do if a caller remembered to invoke it separately.
 */
export async function buildWeeklyCalibrationSummary({
  runsDir,
  cardIdsByType,
  fitDate,
  estimatorVersion = ESTIMATOR_VERSION,
  coverageTarget = DEFAULT_COVERAGE_TARGET,
  listCardUsageEntriesFn = listCardUsageEntries
}) {
  const sampleCounts = {};
  const types = {};
  const indeterminateCardIds = {};

  for (const [type, cardIds] of Object.entries(cardIdsByType)) {
    const { observations, indeterminateCardIds: badCardIds } = await collectObservationsFromLedger({
      runsDir,
      cardIds,
      listCardUsageEntriesFn
    });
    const estimate = estimateCost({ type, observations, coverageTarget });
    sampleCounts[type] = observations.length;
    indeterminateCardIds[type] = badCardIds;
    types[type] = { ...estimate, coverage: measureCoverage(observations, estimate) };
  }

  return { estimatorVersion, fitDate, coverageTarget, sampleCounts, types, indeterminateCardIds };
}
