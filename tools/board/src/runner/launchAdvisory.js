import { decideLaunchAdvisory } from "./advisoryLogger.js";
import { estimateCost, DEFAULT_COVERAGE_TARGET, indeterminateEstimate } from "./costEstimator.js";
import { readUsageTelemetry, WINDOW_KINDS } from "./usageTelemetry.js";
import { evaluateAdmission } from "./admissionDecision.js";
import { listCardUsageEntries, executionTotal } from "./usageLedger.js";
import { listActiveReservations, sumActiveReservedCostUsd, reserveLaunchSlot } from "./launchReservation.js";

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
 * fires, and its eventual settlement (or failure) is simply ignored, the same fire-and-forget
 * posture `usageLedger.js` already takes for the same reason.
 */
export function withBoundedDecide(decideFn, { timeoutMs = DEFAULT_ADVISORY_TIMEOUT_MS, fallback, logger = console } = {}) {
  return function boundedDecide() {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.log(`wip-gate advisory: decide() exceeded ${timeoutMs}ms -- launch proceeds unaffected, recording a timeout hold`);
        resolve(fallback("timeout"));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      Promise.resolve()
        .then(decideFn)
        .then((value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          logger.log(`wip-gate advisory: decide() failed -- launch proceeds unaffected: ${err.message}`);
          resolve(fallback("error", err));
        });
    });
  };
}

function fallbackRecordFactory({ type, fitDate }) {
  return (reason, err) => ({
    estimate: indeterminateEstimate(),
    telemetryReadings: {},
    type,
    fitDate,
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
  reserveLaunchSlotFn = reserveLaunchSlot,
  decideLaunchAdvisoryFn = decideLaunchAdvisory,
  estimateCostFn = estimateCost
}) {
  async function innerDecide() {
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

    const reservedCostUsd = typeof reservedCycle.value === "number" ? Math.max(0, reservedCycle.value - alreadyChargedUsd) : 0;

    let otherActiveReservations = [];
    try {
      otherActiveReservations = await listActiveReservationsFn({ runsDir });
    } catch {
      otherActiveReservations = [];
    }
    const reservedUnspentCostUsd = sumActiveReservedCostUsd(otherActiveReservations);

    const admission = evaluateAdmission({
      telemetryReadings: implementerAdvisory.telemetryReadings,
      estimate: reservedCycle,
      reservedUnspentCostUsd,
      config: admissionConfig
    });

    try {
      await reserveLaunchSlotFn({
        runsDir,
        cardId,
        executionId,
        invocationId,
        owner,
        reservedCostUsd,
        windows: [...WINDOW_KINDS],
        reason: `reserved execution cycle (implementer+review x${maxAttempts}) for ${cardId}`,
        now
      });
    } catch (err) {
      logger.log(`wip-gate advisory: reservation failed for ${cardId}/${executionId}/${invocationId} -- launch proceeds unaffected: ${err.message}`);
    }

    const windowSummary = Object.fromEntries(
      Object.entries(admission.windows).map(([windowKind, decision]) => [windowKind, decision.admitted === null ? decision.holdReason : decision.admitted])
    );

    return {
      estimate: reservedCycle,
      telemetryReadings: implementerAdvisory.telemetryReadings,
      type,
      fitDate,
      reason:
        `${implementerAdvisory.reason}; reserved execution cycle ${reservedCycle.classification} ` +
        `(reservedCostUsd=${reservedCostUsd}, alreadyChargedUsd=${alreadyChargedUsd}); ` +
        `admission=${JSON.stringify(windowSummary)}`,
      admission
    };
  }

  return withBoundedDecide(innerDecide, { timeoutMs, fallback: fallbackRecordFactory({ type, fitDate }), logger });
}
