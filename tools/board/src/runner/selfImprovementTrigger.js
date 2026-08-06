import { computeFlowStats } from "../lib/flowStats.js";
import { draftImprovementCard, isAutoProposedCard, extractBaselineDone } from "../lib/flowImprovementCard.js";
import { createCard as createCardDefault } from "./cardCreation.js";

const ENABLE_VALUES = new Set(["1", "true", "on", "yes"]);
const OPEN_STATUSES = new Set(["backlog", "ready", "in-progress", "validation", "review", "blocked"]);

const DEFAULT_INTERVAL_CARDS = 10;
const DEFAULT_REWORK_THRESHOLD = 0.3;
const DEFAULT_MIN_REWORK_SAMPLE = 5;
const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * FLOW_STATS_SELFIMPROVE_ENABLED env var: default OFF -- the reverse of every other AUTO_* flag
 * in this codebase (which default on, disabled by 0/false/off/no). Those flags all act on cards
 * a human or an already-running card created; this loop can originate a brand new card with
 * nobody having asked for that specific one, so it needs an explicit opt-in. Accepts
 * 1/true/on/yes, case-insensitive.
 */
export function selfImproveEnabledFromEnv() {
  return ENABLE_VALUES.has((process.env.FLOW_STATS_SELFIMPROVE_ENABLED ?? "").toLowerCase());
}

function positiveIntFromEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

function rateFromEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : fallback;
}

export function intervalCardsFromEnv() {
  return positiveIntFromEnv("FLOW_STATS_SELFIMPROVE_INTERVAL_CARDS", DEFAULT_INTERVAL_CARDS);
}

export function reworkThresholdFromEnv() {
  return rateFromEnv("FLOW_STATS_SELFIMPROVE_REWORK_THRESHOLD", DEFAULT_REWORK_THRESHOLD);
}

export function minReworkSampleFromEnv() {
  return positiveIntFromEnv("FLOW_STATS_SELFIMPROVE_MIN_REWORK_SAMPLE", DEFAULT_MIN_REWORK_SAMPLE);
}

export function sweepIntervalMsFromEnv() {
  return positiveIntFromEnv("FLOW_STATS_SELFIMPROVE_SWEEP_INTERVAL_MS", DEFAULT_SWEEP_INTERVAL_MS);
}

function latestAutoProposedCard(tasks) {
  return tasks
    .filter(isAutoProposedCard)
    .sort((a, b) => b.id.localeCompare(a.id))[0] ?? null;
}

/**
 * Pure decision function: given current stats and the task corpus, does a new improvement
 * proposal belong on the board right now? No state file -- the "baseline" this reads back is
 * embedded in the most recent auto-proposed card's own body (see flowImprovementCard.js), so
 * there is nothing that can desync from the actual card corpus. De-dupe: never fires while the
 * most recent auto-proposed card is still open (not done/retired), regardless of what the
 * numbers say, so a persistently bad rework rate can't spam a new card every sweep tick.
 */
export function evaluateTrigger({ stats, tasks, intervalCards, reworkThreshold, minReworkSample }) {
  const latest = latestAutoProposedCard(tasks);
  if (latest && OPEN_STATUSES.has(latest.status)) {
    return null;
  }

  const baselineDone = latest ? (extractBaselineDone(latest.body) ?? 0) : 0;
  const doneDelta = stats.byStatus.done - baselineDone;
  if (doneDelta >= intervalCards) {
    return { reason: "interval", doneDelta, baselineDone };
  }

  if (stats.reworkSample >= minReworkSample && stats.reworkRate >= reworkThreshold) {
    return { reason: "rework-rate", reworkRate: stats.reworkRate, reworkSample: stats.reworkSample, baselineDone };
  }

  return null;
}

/**
 * Periodic sweep, structurally mirroring orphanReaper.js: a cheap store.list() + threshold check
 * on an unref()'d interval, gated by `enabled`. Error handling: store.list() is the one
 * locally-retryable case (a transient FS read, same class runState.js already treats as
 * best-effort) -- one bounded retry, then logged and the tick no-ops. Card creation failure is
 * not retried (not a transient-read situation; the de-dupe guard above means the next tick
 * naturally reconsiders) -- logged via logger.error, never silently swallowed.
 */
export function createSelfImprovementLoop({
  store,
  idAllocator,
  repoRoot,
  tasksDir,
  enabled = selfImproveEnabledFromEnv(),
  intervalCards = intervalCardsFromEnv(),
  reworkThreshold = reworkThresholdFromEnv(),
  minReworkSample = minReworkSampleFromEnv(),
  intervalMs = sweepIntervalMsFromEnv(),
  now = () => new Date(),
  logger = console,
  createCardFn = createCardDefault
}) {
  let timer = null;

  async function listTasksWithRetry() {
    try {
      return await store.list();
    } catch (err) {
      logger.warn(`assembled-board: flow-stats sweep: transient read failure, retrying once: ${err.message}`);
      try {
        return await store.list();
      } catch (retryErr) {
        logger.error(`assembled-board: flow-stats sweep: failed to read task corpus after 1 retry: ${retryErr.message}`);
        return null;
      }
    }
  }

  async function sweepOnce() {
    if (!enabled) return null;

    const tasks = await listTasksWithRetry();
    if (tasks === null) return null;

    const stats = computeFlowStats(tasks);
    const trigger = evaluateTrigger({ stats, tasks, intervalCards, reworkThreshold, minReworkSample });
    if (!trigger) return null;

    const proposal = draftImprovementCard({ stats, trigger, now });
    try {
      const created = await createCardFn({ store, idAllocator, repoRoot, tasksDir, fields: proposal });
      logger.log(`assembled-board: flow-stats self-improvement proposed ${created.id} (${trigger.reason})`);
      return created;
    } catch (err) {
      logger.error(`assembled-board: flow-stats self-improvement failed to create proposal card: ${err.message}`);
      return null;
    }
  }

  function start() {
    if (!enabled || timer) return;
    timer = setInterval(() => {
      sweepOnce().catch((err) => logger.error(`assembled-board: flow-stats sweep failed: ${err.message}`));
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
    sweepOnce,
    start,
    stop,
    get enabled() {
      return enabled;
    }
  };
}
