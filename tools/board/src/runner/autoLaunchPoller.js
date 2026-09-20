import { launchCardRun, CardLaunchError, LAUNCH_TRIGGERS } from "./cardLaunch.js";
import { readUsageSnapshot } from "./usageWindow.js";
import { readUsageTelemetry, WINDOW_KINDS, READING_STATUS } from "./usageTelemetry.js";
import { admissionEnforcementEnabledFromEnv } from "./admissionDecision.js";
import { withTimeout, DEFAULT_BOUND_MS } from "./boundedAwait.js";
import { appendNote } from "./runOrchestrator.js";
import {
  evaluateDrainState,
  computeAgingBoost,
  createDrainWaitTracker,
  drainModeEnabledFromEnv,
  DRAIN_STATUS,
  DEFAULT_DRAIN_CONFIG,
  persistDrainFirstHeld,
  clearPersistedDrainFirstHeld
} from "./drainMode.js";

const ENABLE_VALUES = new Set(["1", "true", "on", "yes"]);

/** Statuses that mean a card is mid-run, independent of what the in-process orchestrator thinks. */
const LIVE_RUN_STATUSES = new Set(["in-progress", "validation"]);

/**
 * Dependencies in either of these states are satisfied -- same rule as `assertCanMoveToInProgress`.
 * Exported (T-0383) so httpApi.js's `dependency_status` computed field uses this exact Set rather
 * than keeping its own copy in lockstep by hand.
 */
export const SATISFIED_DEP_STATUSES = new Set(["done", "retired"]);

const PRIORITY_RANK = new Map([
  ["P0", 0],
  ["P1", 1],
  ["P2", 2],
  ["P3", 3]
]);

/** Sorts after every real priority, so an unset/unknown priority is picked last, never first. */
const UNRANKED_PRIORITY = Number.MAX_SAFE_INTEGER;

/**
 * One tick per Anthropic 5-hour usage window, deliberately matched to the window the usage gate
 * reads (`rate_limit_info.rateLimitType: "five_hour"`). At most one card is started per tick, so
 * the cadence *is* the throughput policy: roughly one auto-started card per usage window, rather
 * than a tight poll that would drain a window as fast as cards finish.
 *
 * Consequence worth knowing before enabling it: the first tick is one full interval after the
 * board process starts, and a restart (a deploy, an auto-restart-on-pull) resets that clock. A
 * board restarted more often than every 5 hours will rarely, if ever, reach a tick. Lower
 * `AUTO_LAUNCH_INTERVAL_MS` if that is the operating pattern.
 */
export const DEFAULT_AUTO_LAUNCH_INTERVAL_MS = 5 * 60 * 60 * 1000;
export const DEFAULT_AUTO_LAUNCH_USAGE_MAX = 0.8;

const LOG_PREFIX = "assembled-board: auto-launch";

/**
 * AUTO_LAUNCH_ENABLED env var: default **OFF**, like FLOW_STATS_SELFIMPROVE_ENABLED and unlike
 * the BOARD_AUTOPULL/AUTO_RESTART_ON_PULL family. Those act on work a human or an already-running
 * card set in motion; this loop starts a brand new card run with nobody having asked for that
 * specific one right then, so merging and deploying the code must not be what switches it on.
 * Accepts 1/true/on/yes, case-insensitive.
 */
export function autoLaunchEnabledFromEnv() {
  return ENABLE_VALUES.has((process.env.AUTO_LAUNCH_ENABLED ?? "").toLowerCase());
}

/** AUTO_LAUNCH_INTERVAL_MS env var: default 5 hours. An explicit 0 disables; garbage falls back. */
export function autoLaunchIntervalMsFromEnv() {
  const raw = process.env.AUTO_LAUNCH_INTERVAL_MS;
  if (raw === undefined || raw === "") return DEFAULT_AUTO_LAUNCH_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AUTO_LAUNCH_INTERVAL_MS;
}

/** AUTO_LAUNCH_USAGE_MAX env var: default 0.80. Out-of-range/garbage input falls back to the default. */
export function autoLaunchUsageMaxFromEnv() {
  const raw = Number(process.env.AUTO_LAUNCH_USAGE_MAX);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_AUTO_LAUNCH_USAGE_MAX;
}

function priorityRank(task) {
  const rank = PRIORITY_RANK.get(task.priority);
  return rank === undefined ? UNRANKED_PRIORITY : rank;
}

/** "T-0042" -> 42. Sorting on the raw id would order T-0100 before T-0021 (string compare). */
function numericId(task) {
  const match = /(\d+)/.exec(task.id ?? "");
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Gate 4 + 5: the single card this tick should start, or `null`.
 *
 * Eligible means status *exactly* `ready` -- deliberately narrower than the Run button's
 * ready/review/blocked, because `review` and `blocked` cards are waiting on a human or on a
 * failure nobody has looked at, and auto-restarting those is a decision this loop has no basis to
 * make. `dispatch`-owned cards are excluded for the same reason `launchCardRun` refuses them:
 * they exist precisely to wait for a human. A dependency that isn't in the corpus at all counts
 * as unmet -- an unresolvable reference is uncertainty, and uncertainty skips.
 *
 * Selection is advisory, not a guard: whatever it returns still goes through `launchCardRun` and
 * has to clear `assertCanMoveToInProgress` against the live store. The dependency filter here
 * only keeps the poller from picking a candidate that would predictably be refused.
 *
 * T-0379: every eligible candidate, in priority order -- not just the first. Under the WIP gate's
 * enforcement flag, the poller's own queue behaviour (`tick()`) tries each of these in turn rather
 * than stalling behind a head-of-queue card the shared admission decision holds on capacity-fit
 * grounds, so a smaller card further back can still be admitted this tick.
 */
export function selectEligibleCardsInOrder(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const eligible = tasks.filter((task) => {
    if (task.status !== "ready") return false;
    if (task.agent === "dispatch") return false;
    return (task.depends_on ?? []).every((depId) => SATISFIED_DEP_STATUSES.has(byId.get(depId)?.status));
  });

  return eligible.sort((a, b) => priorityRank(a) - priorityRank(b) || numericId(a) - numericId(b));
}

/** The single highest-priority eligible card, or `null` -- see `selectEligibleCardsInOrder`. */
export function selectNextCard(tasks) {
  const eligible = selectEligibleCardsInOrder(tasks);
  return eligible.length > 0 ? eligible[0] : null;
}

/**
 * WIP gate T-F (drain mode, spec §9): "waiting cards age so ordinary work is not starved."
 * `candidates` is already priority/id ordered (see `selectEligibleCardsInOrder`); this only
 * breaks ties WITHIN the same priority tier, using `computeAgingBoost` on each card's own wait
 * history from `drainTracker` (a card never held before has boost 0, so it sorts exactly as
 * before this card). Aging never crosses a real priority boundary -- a fresh P0 card still goes
 * before a long-aged P1 one -- so this only protects a same-priority card from being perpetually
 * cut in line by a steady stream of newer arrivals, never overrides priority itself.
 */
export function orderCandidatesWithAging(candidates, { drainTracker, now, config = DEFAULT_DRAIN_CONFIG }) {
  return [...candidates].sort((a, b) => {
    const rankA = priorityRank(a);
    const rankB = priorityRank(b);
    if (rankA !== rankB) return rankA - rankB;
    const boostA = computeAgingBoost({ waitState: drainTracker.get(a.id), now, config });
    const boostB = computeAgingBoost({ waitState: drainTracker.get(b.id), now, config });
    if (boostA !== boostB) return boostB - boostA;
    return numericId(a) - numericId(b);
  });
}


/**
 * WIP gate T-D (launch-time contracts, 2026-09-14): reads the 5-hour and weekly windows
 * INDEPENDENTLY (T-0367's `readUsageTelemetry`), unlike the legacy gate above which reads
 * whichever window's event happens to be newest. A window only blocks when its OWN reading is
 * `measured` and at or above `usageMax` -- an `estimated`/`stale`/`unavailable` reading is
 * unknown capacity, never coerced into a block (the same "unknown stays unknown" rule
 * `admissionDecision.js` applies at the dollar-formula layer, applied here to this simpler
 * utilization-threshold comparison). This is evidence-collection only by default: see
 * `tick()` for where `enforcementEnabled` decides whether this replaces the legacy gate above.
 */
export function evaluateWindowAwareUsageGate({ telemetryReadings, usageMax }) {
  const windows = {};
  const blockedWindows = [];
  for (const windowKind of WINDOW_KINDS) {
    const reading = telemetryReadings[windowKind];
    const isMeasured = Boolean(reading) && reading.classification === READING_STATUS.MEASURED && typeof reading.utilization === "number";
    const blocked = isMeasured ? reading.utilization >= usageMax : null;
    windows[windowKind] = { classification: reading?.classification ?? null, utilization: isMeasured ? reading.utilization : null, blocked };
    if (blocked === true) blockedWindows.push(windowKind);
  }
  return { blocked: blockedWindows.length > 0, blockedWindows, windows };
}

function describeWindowAwareGate(windowAware) {
  return WINDOW_KINDS.map((windowKind) => {
    const w = windowAware.windows[windowKind];
    const state = w.blocked === null ? `unknown(${w.classification})` : w.blocked ? `BLOCKED(${w.utilization})` : `ok(${w.utilization})`;
    return `${windowKind}=${state}`;
  }).join(" ");
}

/** Renders the reset window for a skip line: when the limit frees up, and how long that is. */
function describeReset(usage, nowMs) {
  if (!usage || usage.resetsAtMs === null || usage.resetsAtMs === undefined) {
    return "reset time unknown (telemetry carried no resetsAt)";
  }
  if (usage.resetElapsed) {
    return `${usage.rateLimitType ?? "limit"} window already elapsed -- the next tick re-reads it as fresh`;
  }
  const ms = usage.msUntilReset ?? Math.max(0, usage.resetsAtMs - nowMs);
  const mins = Math.round(ms / 60000);
  const human = mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m` : `${mins}m`;
  return `${usage.rateLimitType ?? "limit"} resets at ${usage.resetsAtIso} (in ${human})`;
}

/**
 * Starts at most one ready card per tick, on an interval, from inside the board process.
 *
 * This replaces an external scheduled task that polled the board over HTTP: living in-process
 * gives it the same `RunOrchestrator`, store, and `tasks/.runs` logs the HTTP server already
 * holds, which is what makes the idle and usage gates trustworthy rather than best-guess. Same
 * shape as `autoPullPoller.js`/`selfImprovementTrigger.js` -- an unref'd `setInterval` started
 * from `boardServer.js`'s bootstrap and stopped by its `close()`.
 *
 * Every tick applies four gates in order and stops at the first that fails, logging why:
 *   1. enabled -- AUTO_LAUNCH_ENABLED (default off) and a non-zero interval;
 *   2. usage -- the newest `rate_limit_event` the runner recorded must report a utilization
 *      strictly below `usageMax`. An undetermined reading skips (see `usageWindow.js`);
 *   3. idle -- `orchestrator.hasActiveRuns()` (the runner's own liveness, not a pgrep) *and* no
 *      card parked at in-progress/validation, which also covers a run owned by a previous
 *      process that the orphan reaper hasn't reconciled yet;
 *   4. eligible -- `selectNextCard`.
 *
 * Fail-safe throughout: every uncertainty (unreadable telemetry, an unreadable store, a refused
 * launch) is a skipped tick, never a forced launch and never an interrupted run. A skipped tick
 * costs nothing -- the next one is `intervalMs` away.
 */
export function createAutoLaunchPoller({
  store,
  orchestrator,
  runsDir,
  enabled = autoLaunchEnabledFromEnv(),
  intervalMs = autoLaunchIntervalMsFromEnv(),
  usageMax = autoLaunchUsageMaxFromEnv(),
  readUsage = readUsageSnapshot,
  readUsageTelemetryFn = readUsageTelemetry,
  enforcementEnabled = admissionEnforcementEnabledFromEnv(),
  drainModeEnabled = drainModeEnabledFromEnv(),
  drainConfig = DEFAULT_DRAIN_CONFIG,
  drainTracker = createDrainWaitTracker(),
  launchFn = launchCardRun,
  now = () => Date.now(),
  logger = console
}) {
  const effectivelyEnabled = Boolean(enabled) && intervalMs > 0;
  let timer = null;
  // T-0383: state `getStatus()` reports over `GET /api/poller`, so an operator (or the
  // nightly-infra-prep sandbox, which cannot reach this host directly) can see what the poller
  // last did without reading the repo or the systemd drop-in. Updated only from inside `tick()`/
  // `start()`/`stop()` -- never read speculatively, so `getStatus()` stays a cheap, synchronous
  // report of already-known state.
  let lastTickAtMs = null;
  let startedAtMs = null;
  let lastResult = null;

  function skip(reason) {
    logger.log(`${LOG_PREFIX}: skipped -- ${reason}`);
    lastResult = { kind: "skip", reason, cardId: null };
    return null;
  }

  async function tick() {
    if (!effectivelyEnabled) return null;
    lastTickAtMs = now();

    // Gate 2: usage.
    let usage;
    try {
      usage = await readUsage({ runsDir, now: now() });
    } catch (err) {
      return skip(`usage could not be determined: ${err.message}`);
    }

    // WIP gate T-D (launch-time contracts, 2026-09-14): read the 5-hour/weekly windows
    // independently (T-0367) and log the comparison against the legacy newest-event decision
    // above, on every tick, regardless of configuration -- this is what lets the difference be
    // judged from evidence before anyone flips WIP_GATE_ENFORCEMENT_ENABLED. Bounded (T-0370 fix
    // round, Codex finding 3: a hung reader must never stall a tick) and failure-isolated: a
    // telemetry read failure or timeout here can never affect the legacy gate's own decision.
    const telemetryReadings = await withTimeout(() => readUsageTelemetryFn({ runsDir, now: now() }), {
      timeoutMs: DEFAULT_BOUND_MS,
      fallback: () => null,
      logger,
      label: `${LOG_PREFIX}: readUsageTelemetry`
    });
    let windowAware = null;
    if (telemetryReadings) {
      windowAware = evaluateWindowAwareUsageGate({ telemetryReadings, usageMax });
      logger.log(
        `${LOG_PREFIX}: usage gate comparison -- legacy(newest-event)=${usage.utilization ?? "unknown"} ` +
          `window-aware=[${describeWindowAwareGate(windowAware)}]`
      );
    } else {
      logger.log(`${LOG_PREFIX}: window-aware usage comparison unavailable`);
    }

    if (enforcementEnabled && windowAware) {
      // Replaces the legacy gate entirely under the flag -- this card never enables it on the
      // live board (see the "Do not" list); default configuration never reaches this branch.
      if (windowAware.blocked) {
        return skip(`window-aware usage gate blocked (enforcement mode): ${windowAware.blockedWindows.join(", ")}`);
      }
    } else if (usage.utilization === null || usage.utilization === undefined) {
      // Genuinely ABSENT telemetry is not the same as a signal we failed to read, and the
      // difference decides whether skipping protects anything.
      //
      // 2026-09-04: this gate sits ahead of the idle gate, so an undetermined reading short-
      // circuited every tick. Telemetry had become unfindable (see usageWindow.js's head-read
      // note), the poller logged "usage could not be determined" every 30 minutes indefinitely,
      // and ready cards sat idle on a completely idle board. Absence of evidence was being read
      // as evidence of saturation.
      //
      // When NO telemetry exists anywhere there is nothing to compare `usageMax` against -- the
      // guard cannot function, so blocking on it protects nothing, and a fresh board (which has
      // never run anything, and so has no telemetry by definition) would never start its first
      // card. Proceed, loudly. The idle gate below and `launchCardRun`'s own guards still stand
      // between this and a double-launch; only the usage ceiling is relaxed, and only when there
      // is no data to enforce it with.
      //
      // Unreadable or unrecognized telemetry keeps failing closed: that IS a signal, just one we
      // could not parse, and launching on a misread rate-limit state is the risk this gate exists
      // for. A snapshot without the field at all is treated as not-absent, so an older
      // `readUsage` shape degrades to the safe branch rather than the permissive one.
      if (usage.telemetryAbsent !== true) {
        return skip(`usage could not be determined: ${usage.reason}`);
      }
      logger.log(
        `${LOG_PREFIX}: no rate-limit telemetry available -- proceeding without a usage ceiling ` +
          `(${usage.reason})`
      );
    } else if (usage.utilization >= usageMax) {
      // Say WHEN it frees up, not just that it is blocked. The reset instant rides along on the
      // same rate_limit_event the utilization came from (see usageWindow.js's resetWindowFrom --
      // the CLI publishes no usage command, so this telemetry is the authoritative reset signal
      // available). Resumption itself already works without scheduling: once `resetsAt` passes,
      // utilizationFromRateLimitInfo reads the window as fresh, so the next ordinary tick
      // proceeds. What was missing was any way to SEE that from the journal.
      return skip(
        `usage ${usage.utilization} >= max ${usageMax} (${usage.reason}); ` +
          describeReset(usage, now())
      );
    }

    // Gate 3: board idle. The orchestrator's own view first (cheap, and authoritative for runs
    // this process started), then the card corpus, which also catches a run stranded by an
    // earlier process.
    if (orchestrator && orchestrator.hasActiveRuns && orchestrator.hasActiveRuns()) {
      return skip("the orchestrator reports an active run");
    }

    let tasks;
    try {
      tasks = await store.list();
    } catch (err) {
      return skip(`the card corpus could not be read: ${err.message}`);
    }

    const live = tasks.filter((task) => LIVE_RUN_STATUSES.has(task.status));
    if (live.length > 0) {
      return skip(`cards still at in-progress/validation: ${live.map((task) => task.id).join(", ")}`);
    }

    // Gates 4 + 5: try eligible candidates, in priority order, through the same guarded path the
    // Run button uses -- every launch here is explicitly `trigger: "auto"` (T-0379: the ONE thing
    // that makes the capacity-fit limit apply at all; there is no config surface on this poller to
    // pass anything else, so it can never reach the manual-override path).
    let candidates = selectEligibleCardsInOrder(tasks);
    if (candidates.length === 0) {
      return skip("no eligible ready card (dependencies unmet, or nothing ready)");
    }

    // WIP gate T-F (drain mode, spec §9): off by default (see drainModeEnabled's own docstring) --
    // ordering is untouched below unless a card has actually been held before, so this can never
    // change which card launches on a board where nothing has ever failed to fit.
    if (drainModeEnabled) {
      candidates = orderCandidatesWithAging(candidates, { drainTracker, now: now(), config: drainConfig });
    }

    const passedOver = [];
    for (const candidate of candidates) {
      try {
        const launched = await launchFn({ orchestrator, id: candidate.id, logger, trigger: LAUNCH_TRIGGERS.AUTO });
        logger.log(`${LOG_PREFIX}: launched ${candidate.id} (${candidate.priority ?? "no priority"})`);
        if (drainModeEnabled) drainTracker.clear(candidate.id);
        if (passedOver.length > 0) {
          logger.log(`${LOG_PREFIX}: passed over ${passedOver.length} earlier-queued card(s) that did not fit -- ${passedOver.join("; ")}`);
        }
        // T-0383: lastResult is what GET /api/poller reports -- refresh it in step with the
        // lastTickAtMs set at the top of this function, same as every other exit from tick().
        lastResult = { kind: "launched", reason: null, cardId: candidate.id };
        return launched;
      } catch (err) {
        if (err instanceof CardLaunchError) {
          if (err.capacityFitHold) {
            // T-0379: a capacity-fit hold is a per-card determination, not a board-wide stop --
            // try the next eligible candidate rather than stalling the whole tick behind one card
            // that doesn't fit. Every OTHER refusal (an unmet dependency the guard alone caught, an
            // already-active run, a round-cap trip, an overrun stop) is unrelated to whether THIS
            // card fits, so it still ends the tick immediately, same as before this card.
            let drainNote = "";
            if (drainModeEnabled) {
              if (err.drainHeldOversized) {
                // cardLaunch.js already blocked the card (status + actionable note) and this
                // launch attempt is the ONLY tick that will ever see it as an eligible candidate --
                // the next tick's store.list() naturally excludes it (status is no longer "ready").
                // Nothing left to track here; clear any prior ordinary-wait bookkeeping for it.
                drainTracker.clear(candidate.id);
                drainNote = " [drain: held_oversized -- auto-blocked, see the card's own note]";
              } else {
                const nowMs = now();
                const priorWaitState = drainTracker.get(candidate.id);
                const drainState = evaluateDrainState({
                  admission: err.admission ?? null,
                  telemetryReadings: err.telemetryReadings ?? null,
                  waitState: priorWaitState,
                  now: nowMs,
                  config: drainConfig
                });
                drainTracker.recordHeld(candidate.id, nowMs, drainState);
                if (!priorWaitState && runsDir) {
                  // FIX ROUND 1: persist ONLY on the card's first hold -- firstHeldAtMs never
                  // changes after that, so there is nothing new to write on a repeat hold.
                  // Fire-and-forget: a failed write must never affect this tick (same posture as
                  // every other best-effort write in this runner).
                  persistDrainFirstHeld({ runsDir, cardId: candidate.id, firstHeldAtMs: nowMs }).catch((persistErr) => {
                    logger.log(`${LOG_PREFIX}: failed to persist drain first-hold timestamp for ${candidate.id}: ${persistErr.message}`);
                  });
                }

                if (drainState.status === DRAIN_STATUS.HELD_WAIT_EXPIRED) {
                  // FIX ROUND 1 finding (a): past the bound this is a terminal hold, not an
                  // indefinite wait -- block the card for a human, exactly like the oversized exit
                  // above, and NEVER launch it: leaving drain must never bypass capacity admission.
                  try {
                    const current = await store.get(candidate.id);
                    if (current) {
                      const updated = await store.update(candidate.id, {
                        status: "blocked",
                        body: appendNote(current.body ?? "", "WIP Gate: Drain Hold (Wait Expired)", drainState.reason)
                      });
                      orchestrator.hub?.broadcast?.({ type: "changed", id: candidate.id, task: updated });
                    }
                  } catch (holdErr) {
                    logger.log(`${LOG_PREFIX}: failed to record the drain-wait-expired hold on ${candidate.id}: ${holdErr.message}`);
                  }
                  // The next tick's store.list() naturally excludes it (status is no longer
                  // "ready") -- nothing left to track here, same precedent as the oversized exit.
                  drainTracker.clear(candidate.id);
                  if (runsDir) {
                    clearPersistedDrainFirstHeld({ runsDir, cardId: candidate.id }).catch(() => {});
                  }
                  drainNote = ` [drain: held_wait_expired -- auto-blocked, see the card's own note]`;
                } else if (drainState.status === DRAIN_STATUS.WAITING) {
                  const nextIso =
                    drainState.nextReconsiderationAtMs !== null ? new Date(drainState.nextReconsiderationAtMs).toISOString() : "unknown";
                  drainNote = ` [drain: waiting on ${drainState.blockingWindow}, next reconsideration ${nextIso}]`;
                }
              }
            }
            passedOver.push(`${candidate.id}: ${err.message}${drainNote}`);
            logger.log(`${LOG_PREFIX}: ${candidate.id} does not fit -- trying the next eligible card: ${err.message}${drainNote}`);
            continue;
          }
          // The guarded path refused it for a reason unrelated to capacity fit. Deliberately no
          // fall-through to the next candidate: a non-capacity refusal is information worth
          // surfacing rather than routing around.
          return skip(`${candidate.id} refused by the run guard: ${err.message}`);
        }
        // An unexpected failure (not a guard refusal) still rethrows -- start()'s tick().catch
        // logs it -- but lastResult must be refreshed in step with the lastTickAtMs set at the top
        // of this function, or getStatus() would pair a fresh lastTickAt with a stale lastResult
        // from an earlier, unrelated tick.
        lastResult = { kind: "error", reason: err.message, cardId: candidate.id };
        throw err;
      }
    }

    return skip(`no eligible card fit the 5-hour window capacity this tick -- held: ${passedOver.join("; ")}`);
  }

  function start() {
    if (!effectivelyEnabled || timer) return;
    logger.log(`${LOG_PREFIX}: enabled (every ${intervalMs}ms, usage max ${usageMax})`);
    startedAtMs = now();
    timer = setInterval(() => {
      tick().catch((err) => logger.error(`${LOG_PREFIX}: tick failed: ${err.message}`));
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  /**
   * T-0383: the whole payload behind `GET /api/poller`. Every field here is already sitting in
   * this closure -- no store read, no git call, no filesystem access -- same "answer from
   * process state alone" posture as `handleHealth` in httpApi.js.
   */
  function getStatus() {
    // `nextTickAt` is an estimate, not a guarantee: `setInterval`'s actual firing can drift, and
    // a tick that skips does not reschedule anything (the interval is fixed). It's still the
    // best available signal, derived from the last tick if there's been one, else from when the
    // timer started.
    const anchorMs = lastTickAtMs ?? startedAtMs;
    const nextTickAtMs = effectivelyEnabled && anchorMs !== null ? anchorMs + intervalMs : null;
    return {
      enabled: effectivelyEnabled,
      intervalMs,
      usageMax,
      running: timer !== null,
      lastTickAt: lastTickAtMs !== null ? new Date(lastTickAtMs).toISOString() : null,
      nextTickAt: nextTickAtMs !== null ? new Date(nextTickAtMs).toISOString() : null,
      lastResult,
      activeRun: Boolean(orchestrator && orchestrator.hasActiveRuns && orchestrator.hasActiveRuns()),
      // WIP gate T-F (drain mode, spec §9): "the blocking window and expected next reconsideration
      // time are shown on ... the board" -- empty whenever drain mode is off (the default), since
      // drainTracker is never written to in that case.
      drain: drainTracker.snapshot()
    };
  }

  return {
    tick,
    start,
    stop,
    getStatus,
    get enabled() {
      return effectivelyEnabled;
    }
  };
}
