import path from "node:path";
import { promises as fs } from "node:fs";
import { WINDOW_KINDS } from "./usageTelemetry.js";
import { HOLD_REASON } from "./admissionDecision.js";

/**
 * WIP gate T-F (spec §9): drain mode decides what happens to a card the shared admission
 * decision (admissionDecision.js) holds on capacity-fit grounds, once enforcement (T-D) is on.
 * Four states:
 *
 *   - CLEAR: no window is confirmed blocked (either fully admitted, or every hold reason is an
 *     "unknown capacity" one -- unmeasured/unestimated/incomparable). Nothing to drain.
 *   - WAITING: a real, measured shortage in a specific window, still within the bound. Aged (see
 *     computeNextReconsideration/computeAgingBoost below) -- the ordinary case.
 *   - HELD_OVERSIZED: the card would still be refused even at that window's theoretical maximum
 *     headroom (admissionDecision.js's own HOLD_REASON.OVERSIZED_ESTIMATE_NEVER_FITS). Waiting
 *     cannot help this one at all, so it exits drain immediately with an actionable reason
 *     instead of occupying a slot in the ordinary wait/retry rotation forever.
 *   - HELD_WAIT_EXPIRED (FIX ROUND 1, Chat round-2 review of #408 finding 2): the bounded wait
 *     itself ran out -- `now` has passed `firstHeldAtMs + maxWaitMs` with the window still
 *     blocked. Distinct from WAITING on purpose: past the bound this is a terminal hold for a
 *     human, not an indefinite retry. `autoLaunchPoller.js` blocks the card for intervention when
 *     it sees this status rather than continuing to report it as merely waiting -- see its own
 *     docstring for why this can never become a free pass around capacity admission.
 */
export const DRAIN_STATUS = Object.freeze({
  CLEAR: "clear",
  WAITING: "waiting",
  HELD_OVERSIZED: "held_oversized",
  HELD_WAIT_EXPIRED: "held_wait_expired"
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
 * FIX ROUND 1: a human-actionable message for a card that has waited as long as this gate will
 * ever wait (`config.maxWaitMs`) without the blocking window freeing up. Names the window and
 * states plainly that this requires a human to intervene -- distinct wording from the oversized
 * reason above, since the two exits mean different things (a permanent misfit vs. a real
 * shortage that simply outlasted the bound).
 */
function buildWaitExpiredReason(windowKind) {
  return (
    `Drain wait bound reached for the ${windowKind} window: this card has waited as long as this ` +
    "gate will ever wait without the window freeing up. Waiting further will not resolve it on " +
    "its own -- a human needs to check capacity or re-scope/split the card before it launches again."
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

  // FIX ROUND 1 (Chat round-2 review of #408, finding 2): past the bound this is a terminal hold,
  // not an indefinite WAITING report with a capped timestamp nobody acts on -- see DRAIN_STATUS's
  // own docstring.
  if (overdue) {
    return {
      status: DRAIN_STATUS.HELD_WAIT_EXPIRED,
      blockingWindow,
      reason: buildWaitExpiredReason(blockingWindow),
      nextReconsiderationAtMs: null,
      reconsiderationBasis: null,
      overdue: true,
      agingBoost: computeAgingBoost({ waitState, now, config })
    };
  }

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
 * In-memory, per-card wait bookkeeping -- `timesPassedOver`/`lastDrainState` are this process's
 * own scratch state, same durability class as autoLaunchPoller.js's own `lastResult`/
 * `lastTickAtMs`. `firstHeldAtMs` is different: FIX ROUND 1 requires it survive a board restart
 * (see persistDrainFirstHeld/loadPersistedDrainWaitState below), so a tracker can be constructed
 * with a `seed` -- a cardId -> firstHeldAtMs map, typically `loadPersistedDrainWaitState`'s own
 * return value -- that pre-populates each card's ORIGINAL deadline rather than starting a fresh
 * one. Persistence itself is a separate concern (see below), kept out of this constructor so
 * `createDrainWaitTracker()` with no arguments -- every existing call site, and every existing
 * test -- stays exactly as synchronous and in-memory-only as before this fix.
 */
export function createDrainWaitTracker({ seed = {} } = {}) {
  const state = new Map();
  for (const [cardId, firstHeldAtMs] of Object.entries(seed)) {
    if (typeof firstHeldAtMs === "number") {
      state.set(cardId, { firstHeldAtMs, timesPassedOver: 0, lastDrainState: null });
    }
  }

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

/**
 * FIX ROUND 1 (Chat round-2 review of #408, finding 2): "the tracker also forgets the original
 * deadline across a board restart, so a restart quietly extends the bound." These three functions
 * are the persistence side of `createDrainWaitTracker`'s in-memory bookkeeping -- ONE JSON sidecar
 * per card under `runsDir/.drain-wait/`, storing ONLY `firstHeldAtMs` (never `timesPassedOver`/
 * `lastDrainState`, which are this process's own scratch state, not durable facts). Same
 * per-entry-file, best-effort posture as launchReservation.js's own lease files -- a failed write
 * here must never block a poller tick, so callers are expected to fire these off without letting a
 * rejection propagate (see autoLaunchPoller.js).
 */
const DRAIN_WAIT_STATE_DIRNAME = ".drain-wait";

function drainWaitStatePath(runsDir, cardId) {
  return path.join(runsDir, DRAIN_WAIT_STATE_DIRNAME, `${cardId}.json`);
}

/** Persists `cardId`'s first-hold timestamp so a board restart resumes the SAME deadline. A no-op when `runsDir` is not provided (drain persistence is opt-in, matching drain mode's own off-by-default posture). */
export async function persistDrainFirstHeld({ runsDir, cardId, firstHeldAtMs, writeFileFn = fs.writeFile, mkdirFn = fs.mkdir }) {
  if (!runsDir) return;
  const filePath = drainWaitStatePath(runsDir, cardId);
  await mkdirFn(path.dirname(filePath), { recursive: true });
  await writeFileFn(filePath, JSON.stringify({ firstHeldAtMs }), "utf8");
}

/** Removes `cardId`'s persisted first-hold timestamp once it leaves drain (launched, or reaches a terminal hold). Never throws for a card that was never persisted. */
export async function clearPersistedDrainFirstHeld({ runsDir, cardId, unlinkFn = fs.unlink }) {
  if (!runsDir) return;
  await unlinkFn(drainWaitStatePath(runsDir, cardId)).catch(() => {});
}

/**
 * Loads every persisted first-hold timestamp under `runsDir` -- called once at startup so a
 * freshly-constructed tracker (`createDrainWaitTracker({ seed })`) resumes each card's ORIGINAL
 * deadline instead of silently starting a new maxWaitMs window. `{}` for a missing directory (a
 * fresh runsDir, or drain mode never engaged before) or a missing `runsDir` argument -- never
 * throws, same fail-open posture as every other best-effort read in this runner.
 */
export async function loadPersistedDrainWaitState({ runsDir, readdirFn = fs.readdir, readFileFn = fs.readFile }) {
  if (!runsDir) return {};
  let names;
  try {
    names = await readdirFn(path.join(runsDir, DRAIN_WAIT_STATE_DIRNAME));
  } catch {
    return {};
  }
  const out = {};
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const cardId = name.slice(0, -".json".length);
    try {
      const parsed = JSON.parse(await readFileFn(path.join(runsDir, DRAIN_WAIT_STATE_DIRNAME, name), "utf8"));
      if (typeof parsed.firstHeldAtMs === "number") out[cardId] = parsed.firstHeldAtMs;
    } catch {
      // Corrupt/unreadable sidecar -- skip it rather than fail the whole load.
    }
  }
  return out;
}

/**
 * FIX ROUND 3 (Chat 2026-09-21 review of #408, finding 1): "terminal holds are in-memory only, so
 * a restart erases them... after a restart neither the seeded drainTracker nor the fresh terminal
 * map knows the card -- and because the card is blocked it is not an eligible candidate, so no
 * later tick ever recreates the entry." The durable side of a terminal hold (HELD_WAIT_EXPIRED /
 * HELD_OVERSIZED) -- ONE JSON sidecar per card under `runsDir/.drain-held/`, storing the FULL
 * terminal drain state (everything getStatus().drain reports for a held card), kept deliberately
 * separate from persistDrainFirstHeld's deadline sidecar above: a terminal hold and an active wait
 * deadline are mutually exclusive states for a card (autoLaunchPoller.js clears the other one
 * whenever it writes this one), and conflating the two files would make it impossible to tell,
 * from disk alone, which state a restart should restore.
 */
const DRAIN_HELD_STATE_DIRNAME = ".drain-held";

function drainHeldStatePath(runsDir, cardId) {
  return path.join(runsDir, DRAIN_HELD_STATE_DIRNAME, `${cardId}.json`);
}

/** Persists `cardId`'s full terminal drain state so a board restart can restore it. A no-op when `runsDir` is not provided. */
export async function persistDrainHeldState({ runsDir, cardId, heldState, writeFileFn = fs.writeFile, mkdirFn = fs.mkdir }) {
  if (!runsDir) return;
  const filePath = drainHeldStatePath(runsDir, cardId);
  await mkdirFn(path.dirname(filePath), { recursive: true });
  await writeFileFn(filePath, JSON.stringify(heldState), "utf8");
}

/** Removes `cardId`'s persisted terminal hold once a human resolves it (or a launch supersedes it). Never throws for a card that was never persisted. */
export async function clearPersistedDrainHeldState({ runsDir, cardId, unlinkFn = fs.unlink }) {
  if (!runsDir) return;
  await unlinkFn(drainHeldStatePath(runsDir, cardId)).catch(() => {});
}

/**
 * Loads every persisted terminal hold under `runsDir` -- called once, on a poller's first tick, so
 * a restart recovers `terminalHolds` without a new constructor argument (recovery must not depend
 * on the caller). `{}` for a missing directory or a missing `runsDir` argument -- never throws.
 */
export async function loadPersistedDrainHeldState({ runsDir, readdirFn = fs.readdir, readFileFn = fs.readFile }) {
  if (!runsDir) return {};
  let names;
  try {
    names = await readdirFn(path.join(runsDir, DRAIN_HELD_STATE_DIRNAME));
  } catch {
    return {};
  }
  const out = {};
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const cardId = name.slice(0, -".json".length);
    try {
      const parsed = JSON.parse(await readFileFn(path.join(runsDir, DRAIN_HELD_STATE_DIRNAME, name), "utf8"));
      if (parsed && typeof parsed.status === "string") out[cardId] = parsed;
    } catch {
      // Corrupt/unreadable sidecar -- skip it rather than fail the whole load.
    }
  }
  return out;
}

/**
 * FIX ROUND 2 (Chat round-3 review of #408, finding 1): "a finished wait leaves its deadline on
 * disk" -- `persistDrainFirstHeld`/`clearPersistedDrainFirstHeld` above are each independently
 * fire-and-forget (`autoLaunchPoller.js` never awaits them, so a tick is never held up by a slow
 * filesystem). Doing both is not the same as doing them IN ORDER: with no coordination, nothing
 * stops a completing persist from outliving a clear that was issued after it -- an outstanding
 * first-hold write for a card's Nth hold can land on disk after a launch that already succeeded
 * and cleared, recreating a deadline for a wait that just finished.
 *
 * Every card gets its own promise chain here, so its persist/clear operations run in ISSUE order,
 * never completion order: a clear queued after a persist always executes -- and always wins --
 * only once that persist's own write has settled. Chains are per-coordinator-instance (never a
 * module-level global) so tests constructing independent coordinators never see cross-test
 * interference, and a failed operation never breaks the chain for the operations queued after it.
 */
export function createDrainWaitStateCoordinator({ runsDir, writeFileFn = fs.writeFile, mkdirFn = fs.mkdir, unlinkFn = fs.unlink } = {}) {
  const chains = new Map();
  const pending = new Set();

  function enqueue(cardId, op) {
    const prior = chains.get(cardId) ?? Promise.resolve();
    const next = prior.then(op, op);
    chains.set(cardId, next);
    const settled = next.then(
      () => {},
      () => {}
    );
    pending.add(settled);
    settled.finally(() => pending.delete(settled));
    return next;
  }

  /** Queues a first-hold persist for `cardId`, after any already-queued operation for that same card. */
  function persistFirstHeld(cardId, firstHeldAtMs) {
    return enqueue(cardId, () => persistDrainFirstHeld({ runsDir, cardId, firstHeldAtMs, writeFileFn, mkdirFn }));
  }

  /** Queues clearing `cardId`'s persisted first-hold, after any already-queued operation for that same card. */
  function clearFirstHeld(cardId) {
    return enqueue(cardId, () => clearPersistedDrainFirstHeld({ runsDir, cardId, unlinkFn }));
  }

  /**
   * FIX ROUND 3: queues a terminal-hold persist for `cardId`, after any already-queued operation
   * for that same card -- same per-card chain as persistFirstHeld/clearFirstHeld above, so a
   * terminal hold recorded moments after a deadline clears (or vice versa) can never race it.
   */
  function persistHeldState(cardId, heldState) {
    return enqueue(cardId, () => persistDrainHeldState({ runsDir, cardId, heldState, writeFileFn, mkdirFn }));
  }

  /** Queues clearing `cardId`'s persisted terminal hold, after any already-queued operation for that same card. */
  function clearHeldState(cardId) {
    return enqueue(cardId, () => clearPersistedDrainHeldState({ runsDir, cardId, unlinkFn }));
  }

  /** Waits for every currently in-flight persist/clear, across every card, to settle -- lets a caller (chiefly a test) observe the ACTUAL final on-disk state rather than racing a fire-and-forget write. */
  async function flush() {
    await Promise.allSettled([...pending]);
  }

  return { persistFirstHeld, clearFirstHeld, persistHeldState, clearHeldState, flush };
}
