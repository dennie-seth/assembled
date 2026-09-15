import { decideLaunchAdvisory, recordAdvisoryDecision } from "./advisoryLogger.js";
import { estimateCost, DEFAULT_COVERAGE_TARGET, indeterminateEstimate } from "./costEstimator.js";
import { readUsageTelemetry, WINDOW_KINDS } from "./usageTelemetry.js";
import { evaluateAdmission as defaultEvaluateAdmission } from "./admissionDecision.js";
import { listCardUsageEntries, executionTotal } from "./usageLedger.js";
import { listActiveReservations, remainingReservedCostUsd, reserveLaunchSlot } from "./launchReservation.js";
import { withTimeout } from "./boundedAwait.js";

/**
 * Serializes the read-active-reservations -> evaluate-admission -> write-own-lease critical
 * section across EVERY concurrent launch this board process handles (T-0370 fix round, Codex
 * review finding 1: "checking capacity and reserving it is one atomic operation over the shared
 * capacity pool"). Both the Run button and the auto-launch poller go through `launchCardRun` ->
 * `buildLaunchDecide`, i.e. this same module, and both launchers live inside the ONE board
 * process that holds board ownership (`boardOwnership.js`) -- a second board process never
 * launches concurrently against the same `runsDir`, so an in-process lock is sufficient (per this
 * card's own governing constraint 3); it does not need to be cross-process. A turn that throws
 * still releases the lock for the next one -- `.then(fn, fn)` runs `fn` either way, and the
 * lock's own continuation swallows both outcomes so one turn's rejection can never wedge the
 * queue for every launch after it.
 */
let capacityLock = Promise.resolve();
function withCapacityLock(fn) {
  const turn = capacityLock.then(fn, fn);
  capacityLock = turn.then(
    () => undefined,
    () => undefined
  );
  return turn;
}

/**
 * Sums every OTHER active reservation's REMAINING (not raw) future cost (T-0370 fix round, Codex
 * review finding 6: "active reservations are counted at their remaining future cost"). Returns
 * `null` -- never `0` -- the instant any part of this read is unreliable: a reservation's own
 * ledger spend lookup failing makes the WHOLE sum indeterminate, since silently treating that one
 * reservation as fully unspent (or fully spent) would misstate the shared pool in whichever
 * direction happens to be wrong.
 */
export async function sumActiveReservedRemainingCostUsd({ runsDir, reservations, listCardUsageEntriesFn = listCardUsageEntries }) {
  let total = 0;
  for (const reservation of reservations) {
    let entries;
    try {
      entries = await listCardUsageEntriesFn({ runsDir, cardId: reservation.cardId });
    } catch {
      return null;
    }
    const spent = executionTotal(entries, reservation.executionId).knownCostUsd;
    const remaining = remainingReservedCostUsd(reservation, spent);
    // T-0370 fix round 2 finding 5: a single reservation with an unknown own cost makes the WHOLE
    // sum an explicit unknown -- never silently treated as 0 (see remainingReservedCostUsd).
    if (remaining === null) return null;
    total += remaining;
  }
  return total;
}

/**
 * WIP gate T-D (launch-time contracts, 2026-09-14): the glue that composes T-0367's per-window
 * telemetry, T-0369's cost estimator + advisory logger, and this card's own reservation ledger
 * into the single `decide()` callback `cardLaunch.js` hands to `withAdvisoryLogging`
 * (advisoryLogger.js). Nothing here re-implements estimation or advisory logging -- it only
 * orchestrates calls into those two modules and this card's own `admissionDecision.js` /
 * `launchReservation.js`.
 */

/** Bounds how long the whole advisory pipeline may run before a launch proceeds regardless (constraint 6: "never refuses or delays a launch"). */
export const DEFAULT_ADVISORY_TIMEOUT_MS = 8000;

/**
 * Maps a card's `agent` to one of `costEstimator.js`'s registered `TYPE_PRIORS` keys. Every
 * agent not listed here returns `null` -- which `estimateCost`/`decideLaunchAdvisory` already
 * treat as an unregistered type (`holdForSizingEstimate`), never a guessed number. Deliberately
 * small and conservative: richer per-agent/per-size calibration is future work (see T-0368's
 * complexity points), not something this card invents unsupported priors for.
 */
const AGENT_TO_COST_TYPE = Object.freeze({
  infra: "infra-small",
  assets: "asset-GPU",
  audio: "asset-GPU"
});

export function resolveCostEstimatorType(task) {
  return AGENT_TO_COST_TYPE[task?.agent] ?? null;
}

function isKnownEstimate(estimate) {
  return Boolean(estimate) && typeof estimate.value === "number" && Number.isFinite(estimate.value);
}

/**
 * Folds the reviewer phase and a bounded retry count into one "reserved execution cycle" cost
 * (acceptance: "retries and reviewer phases are included in the reserved execution cycle").
 * `maxAttempts` mirrors `runOrchestrator.js`'s `MAX_AUTO_RETRY_ATTEMPTS` -- the same bound the
 * real auto-retry loop is capped at, so the reservation covers every attempt the loop could
 * actually spend. An unknown implementer or reviewer estimate makes the whole reserved cycle an
 * explicit hold, never a fabricated number (the same "unknown stays unknown" rule
 * `admissionDecision.js` applies at the window layer).
 */
export function reservedExecutionCycleEstimate({ implementerEstimate, reviewEstimate, maxAttempts }) {
  if (!isKnownEstimate(implementerEstimate) || !isKnownEstimate(reviewEstimate)) {
    return {
      value: null,
      unit: "usd",
      classification: "large_hold_for_sizing",
      estimateSource: "reserved_execution_cycle_unknown",
      estimatorVersion: implementerEstimate?.estimatorVersion ?? reviewEstimate?.estimatorVersion ?? null
    };
  }
  return {
    value: (implementerEstimate.value + reviewEstimate.value) * maxAttempts,
    unit: "usd",
    classification: "reserved_execution_cycle",
    estimateSource: "reserved_execution_cycle",
    estimatorVersion: implementerEstimate.estimatorVersion ?? reviewEstimate.estimatorVersion ?? null,
    maxAttempts
  };
}

/**
 * Wraps `decideFn` so it ALWAYS resolves -- never rejects, never hangs past `timeoutMs` --
 * regardless of what `decideFn` does. This is what makes constraint 6 ("bounded in time and
 * failure-isolated") hold even though `advisoryLogger.js`'s own `withAdvisoryLogging` awaits
 * `decide()` before calling `launch()`: without a timeout of its OWN, a merely-slow (not
 * throwing) `decide()` would still delay the launch, since `withAdvisoryLogging`'s try/catch
 * only guards against a throw, not against a hang. The underlying `decideFn` call is never
 * cancelled (Node has no such primitive) -- it keeps running in the background after a timeout
 * fires, and its eventual settlement (or failure) is simply ignored... except that "ignored" used
 * to mean `decideFn` still finished writing a reservation lease and a pending advisory record on
 * its own time, well after the caller had already moved on with the fallback (T-0370 fix round,
 * Codex review finding 5: a timed-out lease that outlives the run it was for, and a
 * `outcome: null` record nothing will ever attach an outcome to). Two things fix that:
 *
 *  1. `decideFn` is called with a `cancelToken` (`{cancelled}`) that flips to `true` the instant
 *     this wrapper commits to the fallback (timeout OR thrown error) -- `decideFn` is expected to
 *     check it before any write with a durable side effect and skip that write once it's true.
 *  2. `onFallback(fallbackRecord)`, when supplied, is awaited BEFORE the fallback resolves --
 *     this is how the fallback itself gets persisted durably (see `buildLaunchDecide`'s own use:
 *     it calls `recordAdvisoryDecisionFn` with the fallback's fields), so a late
 *     `reconcileLaunchOutcome` always finds a decision to attach an outcome to, even one that
 *     never got past a timeout.
 */
export function withBoundedDecide(decideFn, { timeoutMs = DEFAULT_ADVISORY_TIMEOUT_MS, fallback, onFallback, logger = console } = {}) {
  return function boundedDecide() {
    const cancelToken = { cancelled: false };
    return withTimeout(() => decideFn(cancelToken), {
      timeoutMs,
      logger,
      label: "wip-gate advisory: decide()",
      fallback: (reason, err) => {
        cancelToken.cancelled = true;
        const fallbackRecord = fallback(reason, err);
        if (!onFallback) return fallbackRecord;
        return Promise.resolve()
          .then(() => onFallback(fallbackRecord))
          .catch(() => {})
          .then(() => fallbackRecord);
      }
    });
  };
}

function fallbackRecordFactory({ type, fitDate }) {
  return (reason, err) => ({
    estimate: indeterminateEstimate(),
    telemetryReadings: {},
    type,
    fitDate,
    reservedUnspentCostUsd: null,
    reason: `wip-gate advisory decide() ${reason}${err ? `: ${err.message}` : ""} -- launch proceeded unaffected`,
    admission: null
  });
}

/**
 * Builds the bounded `decide()` callback for one launch (one call through `launchCardRun`).
 * Composes:
 *   1. T-0369's `decideLaunchAdvisory` for the implementer-phase estimate (this card's own
 *      cost-estimator `type`, from `resolveCostEstimatorType`).
 *   2. T-0369's `estimateCost` for the reviewer-phase prior (the registered `"review"` type;
 *      every card's reviewer phase draws from the same prior, there is no per-card reviewer
 *      history to fit against here).
 *   3. `reservedExecutionCycleEstimate` to fold both into one bounded-by-retries reservation.
 *   4. The ledger's `executionTotal` for THIS execution id, so usage already charged is
 *      subtracted rather than double-reserved (never below zero).
 *   5. `admissionDecision.js`'s `evaluateAdmission`, against the OTHER launches' currently
 *      active reservations (read before this one is written, so this launch's own predicted
 *      cost is never counted as part of its own "already reserved" headroom).
 *   6. `launchReservation.js`'s `reserveLaunchSlot` to publish this launch's own lease.
 *
 * Returns a function shaped exactly like `decideLaunchAdvisory`'s own return value
 * (`{estimate, telemetryReadings, type, fitDate, reason}`, plus a non-persisted `admission` for
 * the caller's own logging) so it can be handed straight to `recordAdvisoryDecision`. Wrapped in
 * `withBoundedDecide`: any failure at any step -- including one this function's own try/catches
 * don't already isolate -- degrades to an explicit, still-scoreable hold record rather than
 * ever throwing or hanging.
 */
export function buildLaunchDecide({
  runsDir,
  cardId,
  executionId,
  invocationId,
  type,
  owner,
  maxAttempts,
  coverageTarget = DEFAULT_COVERAGE_TARGET,
  fitDate = null,
  admissionConfig,
  timeoutMs = DEFAULT_ADVISORY_TIMEOUT_MS,
  logger = console,
  now = () => new Date(),
  readUsageTelemetryFn = readUsageTelemetry,
  listCardUsageEntriesFn = listCardUsageEntries,
  listActiveReservationsFn = listActiveReservations,
  sumActiveReservedRemainingCostUsdFn = sumActiveReservedRemainingCostUsd,
  evaluateAdmissionFn = defaultEvaluateAdmission,
  reserveLaunchSlotFn = reserveLaunchSlot,
  decideLaunchAdvisoryFn = decideLaunchAdvisory,
  estimateCostFn = estimateCost,
  recordAdvisoryDecisionFn = recordAdvisoryDecision
}) {
  async function innerDecide(cancelToken) {
    const implementerAdvisory = await decideLaunchAdvisoryFn({
      runsDir,
      cardId,
      type,
      coverageTarget,
      fitDate,
      listCardUsageEntriesFn,
      readUsageTelemetryFn
    });

    const reviewEstimate = estimateCostFn({ type: "review", observations: [], coverageTarget });
    const reservedCycle = reservedExecutionCycleEstimate({
      implementerEstimate: implementerAdvisory.estimate,
      reviewEstimate,
      maxAttempts
    });

    let alreadyChargedUsd = 0;
    try {
      const entries = await listCardUsageEntriesFn({ runsDir, cardId });
      alreadyChargedUsd = executionTotal(entries, executionId).knownCostUsd;
    } catch {
      // Never assume more was spent than proven -- an unreadable ledger reserves the FULL cycle
      // cost rather than under-reserving against unknown prior spend.
      alreadyChargedUsd = 0;
    }

    // T-0370 fix round 2 finding 3/5: the lease stores the REMAINING (future) cost -- already net
    // of what this execution has charged so far -- alongside the `chargedAtReservationUsd`
    // baseline it was computed against, so a later reader (`remainingReservedCostUsd`) subtracts
    // only spend charged AFTER this point, never this same prior spend a second time. An unknown
    // reserved-cycle estimate publishes as an explicit `null` cost, never a fabricated `0` --
    // finding 5: a launch whose own cost is unknown must count as unknown, not free, to every
    // later admission.
    const reservedCostUsd = typeof reservedCycle.value === "number" ? Math.max(0, reservedCycle.value - alreadyChargedUsd) : null;

    // T-0370 fix round (Codex review, finding 1): read-other-reservations, evaluate admission,
    // and write THIS launch's own lease as one atomic turn -- see `withCapacityLock`'s docstring.
    // A pool-listing failure or an unreadable per-reservation ledger spend makes
    // `reservedUnspentCostUsd` `null` (never a fabricated `0`), which `evaluateAdmission` already
    // turns into an explicit `RESERVED_COST_UNKNOWN` hold (finding 6).
    const { reservedUnspentCostUsd, admission } = await withCapacityLock(async () => {
      // T-0370 fix round (Codex review, finding 5): a timeout/error already resolved the caller
      // with a durably-persisted fallback by the time this turn reaches the front of the lock --
      // writing a lease now would only orphan it (nothing will ever release it, since
      // reconcileLaunchOutcome already ran, or will run, against a key this write didn't exist
      // for yet).
      if (cancelToken?.cancelled) {
        logger.log(`wip-gate advisory: decide() for ${cardId}/${executionId}/${invocationId} already timed out/failed -- skipping the late reservation write`);
        return { reservedUnspentCostUsd: null, admission: null };
      }

      let otherActiveReservations;
      try {
        otherActiveReservations = await listActiveReservationsFn({ runsDir });
      } catch {
        otherActiveReservations = null;
      }

      const reservedUnspentCostUsd =
        otherActiveReservations === null
          ? null
          : await sumActiveReservedRemainingCostUsdFn({ runsDir, reservations: otherActiveReservations, listCardUsageEntriesFn });

      // T-0370 fix round 2 finding 3: the candidate's OWN admission input is its future
      // (remaining) cost -- the same `reservedCostUsd` this launch is about to reserve/publish --
      // not the full, gross `reservedCycle`, which would double-count usage this execution has
      // already charged (spec §4: "predicted_remaining_cost_upper_bound is FUTURE consumption").
      const candidateEstimate = typeof reservedCostUsd === "number" ? { ...reservedCycle, value: reservedCostUsd } : reservedCycle;

      const admission = evaluateAdmissionFn({
        telemetryReadings: implementerAdvisory.telemetryReadings,
        estimate: candidateEstimate,
        reservedUnspentCostUsd,
        config: admissionConfig
      });

      // Re-checked: the reads above awaited, so the timeout could have fired while this turn was
      // still in flight.
      if (cancelToken?.cancelled) {
        logger.log(`wip-gate advisory: decide() for ${cardId}/${executionId}/${invocationId} timed out/failed while evaluating admission -- skipping the late reservation write`);
        return { reservedUnspentCostUsd, admission };
      }

      try {
        await reserveLaunchSlotFn({
          runsDir,
          cardId,
          executionId,
          invocationId,
          owner,
          reservedCostUsd,
          chargedAtReservationUsd: alreadyChargedUsd,
          windows: [...WINDOW_KINDS],
          reason: `reserved execution cycle (implementer+review x${maxAttempts}) for ${cardId}`,
          now
        });
      } catch (err) {
        logger.log(`wip-gate advisory: reservation failed for ${cardId}/${executionId}/${invocationId} -- launch proceeds unaffected: ${err.message}`);
      }

      return { reservedUnspentCostUsd, admission };
    });

    // The timeout/error fallback already recorded (and persisted) ITS OWN decision for this
    // launch identity -- a late write here would either orphan a second, outcome-less record or
    // clobber the one `reconcileLaunchOutcome` may already be attaching an outcome to.
    if (cancelToken?.cancelled) {
      logger.log(`wip-gate advisory: decide() for ${cardId}/${executionId}/${invocationId} timed out/failed before persisting -- the fallback record already covers it`);
      return {
        estimate: reservedCycle,
        telemetryReadings: implementerAdvisory.telemetryReadings,
        type,
        fitDate,
        reservedUnspentCostUsd,
        reason: `late decide() result discarded -- already superseded by a timeout/error fallback for ${cardId}/${executionId}/${invocationId}`,
        admission
      };
    }

    const windowSummary = Object.fromEntries(
      Object.entries(admission.windows).map(([windowKind, decision]) => [windowKind, decision.admitted === null ? decision.holdReason : decision.admitted])
    );

    const record = {
      estimate: reservedCycle,
      telemetryReadings: implementerAdvisory.telemetryReadings,
      type,
      fitDate,
      reservedUnspentCostUsd,
      reason:
        `${implementerAdvisory.reason}; reserved execution cycle ${reservedCycle.classification} ` +
        `(reservedCostUsd=${reservedCostUsd}, alreadyChargedUsd=${alreadyChargedUsd}); ` +
        `admission=${JSON.stringify(windowSummary)}`,
      admission
    };

    // The write itself is part of what constraint 6 bounds ("reading telemetry, estimating,
    // reserving or LOGGING"), so it happens inside this same envelope, ahead of `launch()` --
    // never after, and never able to throw or hang past `withBoundedDecide`'s own timeout.
    try {
      await recordAdvisoryDecisionFn({ runsDir, cardId, executionId, invocationId, type, fitDate, estimate: reservedCycle, telemetryReadings: implementerAdvisory.telemetryReadings, reason: record.reason });
    } catch (err) {
      logger.log(`wip-gate advisory: failed to record advisory decision for ${cardId}/${executionId}/${invocationId} -- launch proceeds unaffected: ${err.message}`);
    }

    return record;
  }

  return withBoundedDecide(innerDecide, {
    timeoutMs,
    fallback: fallbackRecordFactory({ type, fitDate }),
    logger,
    // T-0370 fix round (Codex review, finding 5): persists the timeout/error fallback itself, so
    // a later reconcileLaunchOutcome always finds a decision recorded for this launch identity --
    // never a decision that only ever existed in memory, gone the instant this call returns.
    onFallback: (fallbackRecord) =>
      recordAdvisoryDecisionFn({
        runsDir,
        cardId,
        executionId,
        invocationId,
        type,
        fitDate,
        estimate: fallbackRecord.estimate,
        telemetryReadings: fallbackRecord.telemetryReadings,
        reason: fallbackRecord.reason
      })
  });
}
