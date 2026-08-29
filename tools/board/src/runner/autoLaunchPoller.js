import { launchCardRun, CardLaunchError } from "./cardLaunch.js";
import { readUsageSnapshot } from "./usageWindow.js";

const ENABLE_VALUES = new Set(["1", "true", "on", "yes"]);

/** Statuses that mean a card is mid-run, independent of what the in-process orchestrator thinks. */
const LIVE_RUN_STATUSES = new Set(["in-progress", "validation"]);

/** Dependencies in either of these states are satisfied -- same rule as `assertCanMoveToInProgress`. */
const SATISFIED_DEP_STATUSES = new Set(["done", "retired"]);

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
 */
export function selectNextCard(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const eligible = tasks.filter((task) => {
    if (task.status !== "ready") return false;
    if (task.agent === "dispatch") return false;
    return (task.depends_on ?? []).every((depId) => SATISFIED_DEP_STATUSES.has(byId.get(depId)?.status));
  });

  if (eligible.length === 0) return null;
  return eligible.sort((a, b) => priorityRank(a) - priorityRank(b) || numericId(a) - numericId(b))[0];
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
  launchFn = launchCardRun,
  now = () => Date.now(),
  logger = console
}) {
  const effectivelyEnabled = Boolean(enabled) && intervalMs > 0;
  let timer = null;

  function skip(reason) {
    logger.log(`${LOG_PREFIX}: skipped -- ${reason}`);
    return null;
  }

  async function tick() {
    if (!effectivelyEnabled) return null;

    // Gate 2: usage.
    let usage;
    try {
      usage = await readUsage({ runsDir, now: now() });
    } catch (err) {
      return skip(`usage could not be determined: ${err.message}`);
    }
    if (usage.utilization === null || usage.utilization === undefined) {
      return skip(`usage could not be determined: ${usage.reason}`);
    }
    if (usage.utilization >= usageMax) {
      return skip(`usage ${usage.utilization} >= max ${usageMax} (${usage.reason})`);
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

    // Gates 4 + 5: pick one, and start it through the same guarded path the Run button uses.
    const candidate = selectNextCard(tasks);
    if (!candidate) {
      return skip("no eligible ready card (dependencies unmet, or nothing ready)");
    }

    try {
      const launched = await launchFn({ orchestrator, id: candidate.id, logger });
      logger.log(`${LOG_PREFIX}: launched ${candidate.id} (${candidate.priority ?? "no priority"})`);
      return launched;
    } catch (err) {
      if (err instanceof CardLaunchError) {
        // The guarded path refused it. Deliberately no fall-through to the next candidate: at
        // most one launch attempt per tick, and a refusal is information worth surfacing rather
        // than routing around.
        return skip(`${candidate.id} refused by the run guard: ${err.message}`);
      }
      throw err;
    }
  }

  function start() {
    if (!effectivelyEnabled || timer) return;
    logger.log(`${LOG_PREFIX}: enabled (every ${intervalMs}ms, usage max ${usageMax})`);
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

  return {
    tick,
    start,
    stop,
    get enabled() {
      return effectivelyEnabled;
    }
  };
}
