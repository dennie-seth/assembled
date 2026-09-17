import { measureRecordedCoverage } from "./advisoryLogger.js";

/** How much of the recorded predicted-vs-actual evidence must be exceeded before this counts as a systemic overrun, not noise. */
export const DEFAULT_OVERRUN_EXCEEDED_FRACTION = 0.5;

/** Minimum evaluated predictions required before an overrun can be flagged at all -- a couple of misses on a freshly-deployed estimator is not a signal. */
export const DEFAULT_OVERRUN_MIN_EVALUATED = 3;

/**
 * Spec §11 / T-0370 fix round (Codex review, finding 2): "record estimate overruns; in
 * enforcement mode stop admitting new work". Aggregates T-0369's own coverage evidence
 * (`advisoryLogger.js`'s `measureRecordedCoverage`) across every estimator/fit group into one
 * exceeded-fraction, and flags an overrun only once there is ENOUGH evidence to trust it
 * (`minEvaluated`). Never treats an unreadable coverage read as an overrun signal -- it fails
 * open (no overrun detected) rather than escalate on a read failure, since "unknown capacity"
 * is already the admission formula's own job; this policy only ever acts on evidence it
 * actually has.
 */
export async function evaluateOverrunPolicy({
  runsDir,
  measureRecordedCoverageFn = measureRecordedCoverage,
  exceededFractionThreshold = DEFAULT_OVERRUN_EXCEEDED_FRACTION,
  minEvaluated = DEFAULT_OVERRUN_MIN_EVALUATED
}) {
  let coverage;
  try {
    coverage = await measureRecordedCoverageFn({ runsDir });
  } catch {
    return { overrun: false, reason: "coverage evidence unreadable -- not treated as an overrun signal", evaluated: 0, exceeded: 0, fraction: null };
  }

  let evaluated = 0;
  let exceeded = 0;
  for (const group of Object.values(coverage.groups ?? {})) {
    evaluated += group.evaluated;
    exceeded += group.exceeded;
  }

  if (evaluated < minEvaluated) {
    return { overrun: false, reason: `insufficient evidence (${evaluated} evaluated, need ${minEvaluated})`, evaluated, exceeded, fraction: null };
  }

  const fraction = exceeded / evaluated;
  const overrun = fraction >= exceededFractionThreshold;
  return {
    overrun,
    reason: overrun
      ? `estimate overrun: ${exceeded}/${evaluated} predictions exceeded (${fraction.toFixed(2)} >= ${exceededFractionThreshold})`
      : `within tolerance: ${exceeded}/${evaluated} exceeded (${fraction.toFixed(2)} < ${exceededFractionThreshold})`,
    evaluated,
    exceeded,
    fraction
  };
}

/**
 * Spec §11's "bounded continuation policy": while an overrun stop is active, a brand-new
 * admission is refused, but a card that is already mid-cycle -- it already has ledger history
 * for THIS execution, meaning a prior attempt already ran under the reservation this launch's
 * own retry loop is continuing -- may still proceed. Refusing an in-flight card's own retry
 * would abandon already-spent work rather than bound it.
 */
export function isBoundedContinuation({ priorEntriesForExecution }) {
  return Array.isArray(priorEntriesForExecution) && priorEntriesForExecution.length > 0;
}
