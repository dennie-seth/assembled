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
  PRIOR_RAISED_BY_OBSERVATION: "type_prior_raised_by_observation",
  CONSERVATIVE_FALLBACK: "conservative_lower_bound_fallback",
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
function holdForSizingEstimate({ sampleCount = 0, exactCount = 0, censoredCount = 0 } = {}) {
  return {
    value: null,
    unit: "usd",
    estimateSource: ESTIMATE_SOURCE.UNKNOWN_HOLD,
    estimatorVersion: ESTIMATOR_VERSION,
    uncertainty: null,
    classification: "large_hold_for_sizing",
    sampleCount,
    exactCount,
    censoredCount
  };
}

/**
 * Sentinel for "consumption exists but could not be read consistently" (T-0367 consumer contract
 * 1): never a `0`/`[]`/skipped observation. Shared by the advisory logger's own indeterminate
 * ledger-read path and the weekly summary's per-type indeterminate path, so both present the same
 * `classification`/`consumption` shape a caller can key off of.
 */
export function indeterminateEstimate({ sampleCount = 0, exactCount = 0, censoredCount = 0 } = {}) {
  return {
    value: null,
    unit: "usd",
    estimateSource: "ledger_read_indeterminate",
    estimatorVersion: ESTIMATOR_VERSION,
    uncertainty: null,
    classification: "indeterminate",
    consumption: "indeterminate",
    sampleCount,
    exactCount,
    censoredCount
  };
}

/**
 * The only `outcome` string runOrchestrator.js writes that means the phase actually finished its
 * work successfully (`runOrchestrator.js:892,983,1062,2122`). Every other outcome it writes --
 * `quota_stop` (a terminal 429 mid-stream, `:888-894`), `reviewer_fail` (a completed but non-PASS
 * verdict, `:981-986`), `phase_timeout`, `cancelled`, `crashed`, `in_progress` -- and any outcome
 * this module has never seen (a later addition to the producer) all mean "the process ended" or
 * "is still running", never "the work succeeded", and are censored lower bounds (Codex WIP-gate
 * batch review finding 3). Fail-safe: an unrecognized outcome is never treated as exact.
 */
const SUCCESSFUL_OUTCOME = "success";

/**
 * Converts one usage-ledger attempt entry (`recordAttemptUsage`'s own shape: `costUsd`,
 * `complete`, `outcome`) into a calibration observation. `complete` alone describes only whether
 * the phase process ended -- it is `true` on a quota stop and on a reviewer failure just as much
 * as on a genuine success (see `SUCCESSFUL_OUTCOME` above), so exactness requires BOTH `complete
 * === true` AND `outcome === "success"` (spec §2 "Censored observations"; Codex WIP-gate batch
 * review finding 3). Everything else -- incomplete, non-success, or unknown-cost even when
 * `complete` -- is a censored LOWER bound, never a finished figure. A `complete === true` entry
 * whose own `costUsd` is `null` (usageLedger's documented "valid result event with no
 * total_cost_usd figure" case) is likewise censored, not a measured zero.
 */
export function observationFromAttemptEntry(entry) {
  const hasKnownCost = typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd);
  if (entry.complete === true && entry.outcome === SUCCESSFUL_OUTCOME && hasKnownCost) {
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

/** Splits a pool of observations into exact costs and censored lower bounds (never mixed). */
function splitObservations(observations) {
  const exact = [];
  const censoredLowerBounds = [];
  for (const observation of observations) {
    if (observation.censored) censoredLowerBounds.push(observation.lowerBoundUsd);
    else exact.push(observation.costUsd);
  }
  return { exact, censoredLowerBounds };
}

/**
 * Sparse-data path (spec §2 "Priors"; Codex WIP-gate batch review finding 2): below
 * `MIN_SAMPLES_FOR_EMPIRICAL_ESTIMATE` exact observations, the registered `TYPE_PRIORS[type]` is
 * the starting point -- but the sparse-data prior must never sit below proven consumption. Any
 * exact cost or censored lower bound already observed ABOVE the prior raises the estimate to at
 * least that amount, under its own classification (`prior_raised_by_observation`), rather than
 * silently discarding it. A censored lower bound of 0 (cost genuinely unknown) carries no
 * magnitude and never raises anything on its own.
 */
function sparseEstimate({ type, exact, censoredLowerBounds, sampleCount, coverageTarget }) {
  const exactCount = exact.length;
  const censoredCount = censoredLowerBounds.length;
  const prior = TYPE_PRIORS[type];
  if (!prior) return holdForSizingEstimate({ sampleCount, exactCount, censoredCount });

  const provenFloor = Math.max(0, ...exact, ...censoredLowerBounds);
  if (provenFloor > prior.value) {
    return {
      value: provenFloor + prior.uncertainty,
      unit: prior.unit,
      estimateSource: ESTIMATE_SOURCE.PRIOR_RAISED_BY_OBSERVATION,
      estimatorVersion: ESTIMATOR_VERSION,
      coverageTarget,
      uncertainty: { measure: "prior_margin_over_observed_floor", value: prior.uncertainty },
      sampleCount,
      exactCount,
      censoredCount,
      classification: "prior_raised_by_observation"
    };
  }

  return {
    value: prior.value,
    unit: prior.unit,
    estimateSource: ESTIMATE_SOURCE.PRIOR,
    estimatorVersion: ESTIMATOR_VERSION,
    coverageTarget,
    uncertainty: { measure: "prior_fixed", value: prior.uncertainty },
    sampleCount,
    exactCount,
    censoredCount,
    classification: "prior"
  };
}

/**
 * Empirical path (spec §2/§7; Codex WIP-gate batch review finding 1) -- reached only once at
 * least `MIN_SAMPLES_FOR_EMPIRICAL_ESTIMATE` EXACT observations exist. The candidate quantile and
 * its stddev margin come from the exact observations alone -- a censored lower bound never enters
 * that arithmetic as if it were a final cost. Every censored observation is then checked against
 * the candidate: one whose lower bound already exceeds it is a KNOWN exceedance (proven), one
 * whose lower bound is at or below it is a POTENTIAL exceedance (its true cost is unresolved and
 * may still be higher). If known-plus-potential exceedances are more than the coverage target
 * allows (`1 - coverageTarget` of the whole pool), the candidate quantile isn't supported by data
 * this uncertain -- return a separately classified, still-raised conservative fallback (at least
 * the highest lower bound plus a margin) instead of ever calling it "empirical".
 */
function empiricalEstimate({ exact, censoredLowerBounds, sampleCount, coverageTarget }) {
  const exactCount = exact.length;
  const censoredCount = censoredLowerBounds.length;
  const poolSize = exactCount + censoredCount;

  const sortedExact = [...exact].sort((a, b) => a - b);
  const mean = sortedExact.reduce((a, b) => a + b, 0) / sortedExact.length;
  const stddevValue = standardDeviation(sortedExact, mean);
  const quantileValue = quantileOf(sortedExact, coverageTarget);
  const candidateValue = quantileValue + stddevValue;

  const knownExceedances =
    exact.filter((v) => v > candidateValue).length + censoredLowerBounds.filter((v) => v > candidateValue).length;
  const potentialExceedances = censoredLowerBounds.filter((v) => v <= candidateValue).length;
  const totalRisk = knownExceedances + potentialExceedances;
  const allowedExceedanceFraction = 1 - coverageTarget;

  if (poolSize > 0 && totalRisk / poolSize > allowedExceedanceFraction) {
    const highestLowerBound = censoredLowerBounds.length ? Math.max(...censoredLowerBounds) : 0;
    const floor = Math.max(candidateValue, highestLowerBound);
    const margin = Math.max(stddevValue, highestLowerBound * 0.1, 0.01);
    return {
      value: floor + margin,
      unit: "usd",
      estimateSource: ESTIMATE_SOURCE.CONSERVATIVE_FALLBACK,
      estimatorVersion: ESTIMATOR_VERSION,
      coverageTarget,
      uncertainty: { measure: "censored_unsupported_margin", value: margin },
      sampleCount,
      exactCount,
      censoredCount,
      classification: "conservative_fallback"
    };
  }

  return {
    value: candidateValue,
    unit: "usd",
    estimateSource: ESTIMATE_SOURCE.EMPIRICAL,
    estimatorVersion: ESTIMATOR_VERSION,
    coverageTarget,
    quantileValue,
    uncertainty: { measure: "stddev", value: stddevValue, z: 1 },
    sampleCount,
    exactCount,
    censoredCount,
    classification: "empirical"
  };
}

/**
 * Fits one type's cost estimate from its calibration observations (spec §2/§7). Coverage, not
 * average: the reported value is an upper quantile (`coverageTarget`, default 0.9) PLUS an
 * uncertainty margin -- never a plain mean. Only EXACT observations count toward
 * `MIN_SAMPLES_FOR_EMPIRICAL_ESTIMATE` (Codex WIP-gate batch review finding 1) -- a pool of
 * censored-only observations, however large, falls to the sparse-data path (`sparseEstimate`),
 * never to a confident-looking empirical fit built from lower bounds treated as final costs.
 */
export function estimateCost({ type, observations, coverageTarget = DEFAULT_COVERAGE_TARGET }) {
  const { exact, censoredLowerBounds } = splitObservations(observations);
  const sampleCount = observations.length;

  if (exact.length < MIN_SAMPLES_FOR_EMPIRICAL_ESTIMATE) {
    return sparseEstimate({ type, exact, censoredLowerBounds, sampleCount, coverageTarget });
  }
  return empiricalEstimate({ type, exact, censoredLowerBounds, sampleCount, coverageTarget });
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
 * sample count -- never silently folded into a smaller-but-confident pool.
 *
 * A type with ANY indeterminate card read (Codex WIP-gate batch review finding 4) never publishes
 * a usable prior or empirical estimate from the reduced, readable-only pool -- that would present
 * a number as trustworthy when real consumption from the unreadable cards is simply missing from
 * it. Instead it gets `indeterminateEstimate()`'s explicit shape plus a `reason` naming the
 * offending cards; what the readable subset alone would have fit is still surfaced, but only under
 * `provisionalFitDiagnostic`, explicitly `usable: false`.
 *
 * Every type's per-type entry carries `inSampleFitDiagnostic` (Codex WIP-gate batch review finding
 * 5) rather than a field named `coverage`: fitting an estimate from a pool and then scoring that
 * SAME pool against it is a fit-on-training-data check, not real coverage. Real coverage compares
 * realized outcomes against their own pre-launch, immutable recorded predictions -- see
 * `advisoryLogger.js`'s `measureRecordedCoverage`, which reads those recorded predictions instead
 * of refitting.
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
    indeterminateCardIds[type] = badCardIds;
    sampleCounts[type] = observations.length;

    if (badCardIds.length > 0) {
      const exactCount = observations.filter((o) => !o.censored).length;
      const censoredCount = observations.filter((o) => o.censored).length;
      const provisional = estimateCost({ type, observations, coverageTarget });
      types[type] = {
        ...indeterminateEstimate({ sampleCount: observations.length, exactCount, censoredCount }),
        coverageTarget,
        reason: `indeterminate ledger read(s) for card(s) ${badCardIds.join(", ")} -- ${type} estimate and coverage withheld until resolved`,
        inSampleFitDiagnostic: { evaluated: 0, exceeded: 0, fraction: null },
        provisionalFitDiagnostic: { ...provisional, usable: false }
      };
      continue;
    }

    const estimate = estimateCost({ type, observations, coverageTarget });
    types[type] = { ...estimate, inSampleFitDiagnostic: measureCoverage(observations, estimate) };
  }

  return { estimatorVersion, fitDate, coverageTarget, sampleCounts, types, indeterminateCardIds };
}
