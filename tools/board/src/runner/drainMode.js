import { WINDOW_KINDS } from "./usageTelemetry.js";
import { HOLD_REASON } from "./admissionDecision.js";

/**
 * WIP gate T-F (spec §9): drain mode decides what happens to a card the shared admission
 * decision (admissionDecision.js) holds on capacity-fit grounds, once enforcement (T-D) is on.
 * Three states:
 *
 *   - CLEAR: no window is confirmed blocked (either fully admitted, or every hold reason is an
 *     "unknown capacity" one -- unmeasured/unestimated/incomparable). Nothing to drain.
 *   - WAITING: a real, measured shortage in a specific window. Bounded and aged (see
 *     computeNextReconsideration/computeAgingBoost below) -- the ordinary case.
 *   - HELD_OVERSIZED: the card would still be refused even at that window's theoretical maximum
 *     headroom (admissionDecision.js's own HOLD_REASON.OVERSIZED_ESTIMATE_NEVER_FITS). Waiting
 *     cannot help this one at all, so it exits drain immediately with an actionable reason
 *     instead of occupying a slot in the ordinary wait/retry rotation forever.
 */
export const DRAIN_STATUS = Object.freeze({
  CLEAR: "clear",
  WAITING: "waiting",
  HELD_OVERSIZED: "held_oversized"
});

// seven_day dominates when both windows are blocked: only ITS OWN reset can ever resolve a
// weekly shortfall, so naming five_hour as "the" blocking window would make waiting look like it
// is about to pay off far sooner than it actually will (spec §9: "a weekly shortage cannot be
// solved by waiting for a 5-hour reset").
const BLOCKING_WINDOW_PRIORITY = ["seven_day", "five_hour"];

/**
 * Bounded, off-by-default scaffolding (spec §9): `maxWaitMs` caps how far in the future this
 * gate will ever report a reconsideration instant, regardless of how far away a window's own
 * reset actually is -- a card is never told "come back never." `fallbackRecheckMs` is what a
 * card reconsiders on when the blocking window's own reset is unknown (never "unknown forever").
 * `agingStepMs` is one unit of wait credit -- see computeAgingBoost.
 */
export const DEFAULT_DRAIN_CONFIG = Object.freeze({
  maxWaitMs: 7 * 24 * 60 * 60 * 1000,
  fallbackRecheckMs: 5 * 60 * 60 * 1000,
  agingStepMs: 60 * 60 * 1000
});

const ENABLE_VALUES = new Set(["1", "true", "on", "yes"]);

/**
 * WIP_GATE_DRAIN_MODE_ENABLED env var: default OFF, same posture as
 * admissionDecision.js's admissionEnforcementEnabledFromEnv -- a separate, later-phase switch
 * ("T-F" is its own letter in the set, gated behind "T-D" enforcement but not implied by it).
 * Never enabled on the live board by this card; turning it on is Dennie's call.
 */
export function drainModeEnabledFromEnv() {
  return ENABLE_VALUES.has((process.env.WIP_GATE_DRAIN_MODE_ENABLED ?? "").toLowerCase());
}

/** A human-actionable message: names the window, states why waiting cannot help, and suggests the only two ways forward. */
function buildOversizedReason(windowKind) {
  return (
    `Oversized for the ${windowKind} window: this card's predicted cost would still be refused ` +
    "even at that window's maximum possible headroom -- waiting for it to free up cannot help. " +
    "Split this card into smaller units or re-scope it before the next attempt."
  );
}

/**
 * Before draining (spec §9): a card whose estimate exceeds the maximum usable 5-hour OR weekly
 * window is a permanent misfit, never a temporary shortage. Detected here from
 * admissionDecision.js's own `HOLD_REASON.OVERSIZED_ESTIMATE_NEVER_FITS` -- that reason is only
 * ever set when the estimate was otherwise comparable (a measured reading, a known estimate, a
 * known reserved cost, comparable units), so this never fabricates an oversized verdict out of
 * an unknown/incomparable hold.
 */
export function detectOversizedCard({ admission }) {
  if (!admission || !admission.windows) return null;
  for (const windowKind of WINDOW_KINDS) {
    const decision = admission.windows[windowKind];
    if (decision && decision.holdReason === HOLD_REASON.OVERSIZED_ESTIMATE_NEVER_FITS) {
      return { windowKind, reason: buildOversizedReason(windowKind) };
    }
  }
  return null;
}

/**
 * Names the ONE window actually blocking this card, or `null` if none is confirmed blocked
 * (`admitted === false`; an unknown hold like NO_MEASURED_READING/ESTIMATE_UNKNOWN is not a
 * confirmed shortage, so it is not "blocking" in the drain sense). When both windows are
 * blocked, seven_day always wins -- see BLOCKING_WINDOW_PRIORITY's docstring above.
 */
export function selectBlockingWindow({ admission }) {
  if (!admission || !admission.windows) return null;
  for (const windowKind of BLOCKING_WINDOW_PRIORITY) {
    if (admission.windows[windowKind]?.admitted === false) return windowKind;
  }
  return null;
}

/**
 * When will this card's blocking window next be worth reconsidering? Uses the BLOCKING window's
 * OWN reset instant when it is known and not already elapsed (spec §9: never solve a weekly
 * shortage by pointing at a five_hour reset just because it comes sooner). Falls back to a fixed
 * recheck cadence when that reset is unknown or stale -- never "unknown forever". Either way, the
 * result is bounded to `firstHeldAtMs + config.maxWaitMs` (or `now + maxWaitMs` for a card with no
 * prior wait history), so a distant real reset is still reported honestly as bounded, not skipped.
 */
export function computeNextReconsideration({ blockingWindow, telemetryReadings, waitState, now, config = DEFAULT_DRAIN_CONFIG }) {
  const reading = telemetryReadings ? telemetryReadings[blockingWindow] : null;
  const heldSinceMs = typeof waitState?.firstHeldAtMs === "number" ? waitState.firstHeldAtMs : now;
  const boundMs = heldSinceMs + config.maxWaitMs;

  let candidateMs;
  let basis;
  if (reading && typeof reading.resetsAtMs === "number" && reading.resetElapsed !== true) {
    candidateMs = reading.resetsAtMs;
    basis = "window_reset";
  } else {
    candidateMs = now + config.fallbackRecheckMs;
    basis = "fallback_recheck";
  }

  const bounded = candidateMs > boundMs;
  return {
    nextReconsiderationAtMs: bounded ? boundMs : candidateMs,
    basis: bounded ? "bounded_max_wait" : basis,
    overdue: now >= boundMs
  };
}

/**
 * Waiting cards age so ordinary work is not starved (spec §9): one point of "wait credit" per
 * full `agingStepMs` elapsed since a card was first held. `autoLaunchPoller.js`'s
 * `orderCandidatesWithAging` uses this to let a long-waiting card eventually outrank a newer
 * same-priority arrival, instead of being passed over indefinitely by a steady stream of smaller
 * cards that keep fitting.
 */
export function computeAgingBoost({ waitState, now, config = DEFAULT_DRAIN_CONFIG }) {
  if (!waitState || typeof waitState.firstHeldAtMs !== "number") return 0;
  const elapsedMs = Math.max(0, now - waitState.firstHeldAtMs);
  return Math.floor(elapsedMs / config.agingStepMs);
}

/**
 * The composed drain decision for one card, given the shared admission decision
 * (admissionDecision.js's `evaluateAdmission` result), the raw per-window telemetry readings, and
 * this card's own prior wait bookkeeping (`createDrainWaitTracker`'s per-card state, or `null` for
 * a card never held before). Oversized always takes priority over an ordinary shortage: no amount
 * of waiting/aging matters once waiting cannot help at all.
 */
export function evaluateDrainState({ admission, telemetryReadings, waitState = null, now, config = DEFAULT_DRAIN_CONFIG }) {
  const oversized = detectOversizedCard({ admission });
  if (oversized) {
    return {
      status: DRAIN_STATUS.HELD_OVERSIZED,
      blockingWindow: oversized.windowKind,
      reason: oversized.reason,
      nextReconsiderationAtMs: null,
      agingBoost: 0
    };
  }

  const blockingWindow = selectBlockingWindow({ admission });
  if (!blockingWindow) {
    return { status: DRAIN_STATUS.CLEAR, blockingWindow: null, reason: null, nextReconsiderationAtMs: null, agingBoost: 0 };
  }

  const { nextReconsiderationAtMs, basis, overdue } = computeNextReconsideration({
    blockingWindow,
    telemetryReadings,
    waitState,
    now,
    config
  });

  return {
    status: DRAIN_STATUS.WAITING,
    blockingWindow,
    reason: `${blockingWindow} window is at capacity -- reconsidering once it resets or the wait bound is reached`,
    nextReconsiderationAtMs,
    reconsiderationBasis: basis,
    overdue,
    agingBoost: computeAgingBoost({ waitState, now, config })
  };
}

/**
 * In-memory, per-card wait bookkeeping -- same durability class as autoLaunchPoller.js's own
 * `lastResult`/`lastTickAtMs` (deliberately not persisted to the store or a runsDir file: a board
 * restart resets what any human currently knows about a card's wait history too, so starting
 * drain tracking fresh on restart is consistent, not a gap).
 */
export function createDrainWaitTracker() {
  const state = new Map();

  /** Records (or continues) a hold for `cardId` as of `now`, optionally attaching the latest computed drain state for `snapshot()` to report. */
  function recordHeld(cardId, now, drainState = null) {
    const existing = state.get(cardId);
    if (existing) {
      existing.timesPassedOver += 1;
      if (drainState) existing.lastDrainState = drainState;
      return existing;
    }
    const fresh = { firstHeldAtMs: now, timesPassedOver: 1, lastDrainState: drainState };
    state.set(cardId, fresh);
    return fresh;
  }

  function get(cardId) {
    return state.get(cardId) ?? null;
  }

  function clear(cardId) {
    state.delete(cardId);
  }

  /** Every currently-tracked card's wait bookkeeping merged with its latest drain state -- what `getStatus().drain` (GET /api/poller) and the `drain_state` computed field report. */
  function snapshot() {
    const out = {};
    for (const [cardId, waitState] of state) {
      out[cardId] = {
        firstHeldAtMs: waitState.firstHeldAtMs,
        timesPassedOver: waitState.timesPassedOver,
        ...(waitState.lastDrainState ?? {})
      };
    }
    return out;
  }

  return { recordHeld, get, clear, snapshot };
}
