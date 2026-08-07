import { computeFlowStats } from "../lib/flowStats.js";
import {
  draftImprovementCard,
  isAutoProposedCard,
  extractBaselineDone,
  extractProposedAt
} from "../lib/flowImprovementCard.js";
import { createCard as createCardDefault } from "./cardCreation.js";

const ENABLE_VALUES = new Set(["1", "true", "on", "yes"]);
const OPEN_STATUSES = new Set(["backlog", "ready", "in-progress", "validation", "review", "blocked"]);

const DEFAULT_REWORK_THRESHOLD = 0.3;
const DEFAULT_MIN_REWORK_SAMPLE = 10;
const DEFAULT_MIN_INTERVAL_DAYS = 7;
const DEFAULT_MIN_RETRY_CAP_BLOCKED = 3;
const DEFAULT_MIN_RECOVERED = 3;
const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const EVIDENCE_LIMIT = 5;

const FAIL_NOTE_CAPTURE_RE = /^## Validation: FAIL \(([^)]+)\)/gm;
const RECOVERED_NOTE_CAPTURE_RE = /^## Recovered \(([^)]+)\)/gm;
const RETRY_CAP_TEXT_RE = /Auto-retry limit reached/;

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

export function reworkThresholdFromEnv() {
  return rateFromEnv("FLOW_STATS_SELFIMPROVE_REWORK_THRESHOLD", DEFAULT_REWORK_THRESHOLD);
}

export function minReworkSampleFromEnv() {
  return positiveIntFromEnv("FLOW_STATS_SELFIMPROVE_MIN_REWORK_SAMPLE", DEFAULT_MIN_REWORK_SAMPLE);
}

/** Floor on how often the loop may propose a new card, regardless of how many thresholds are crossed. */
export function minIntervalDaysFromEnv() {
  return positiveIntFromEnv("FLOW_STATS_SELFIMPROVE_MIN_INTERVAL_DAYS", DEFAULT_MIN_INTERVAL_DAYS);
}

export function minRetryCapBlockedFromEnv() {
  return positiveIntFromEnv("FLOW_STATS_SELFIMPROVE_MIN_RETRY_CAP_BLOCKED", DEFAULT_MIN_RETRY_CAP_BLOCKED);
}

export function minRecoveredFromEnv() {
  return positiveIntFromEnv("FLOW_STATS_SELFIMPROVE_MIN_RECOVERED", DEFAULT_MIN_RECOVERED);
}

export function sweepIntervalMsFromEnv() {
  return positiveIntFromEnv("FLOW_STATS_SELFIMPROVE_SWEEP_INTERVAL_MS", DEFAULT_SWEEP_INTERVAL_MS);
}

function latestAutoProposedCard(tasks) {
  return tasks
    .filter(isAutoProposedCard)
    .sort((a, b) => b.id.localeCompare(a.id))[0] ?? null;
}

function windowFrom(evidence) {
  const timestamps = evidence.map((e) => e.timestamp).filter(Boolean).sort();
  if (timestamps.length === 0) return { windowStart: null, windowEnd: null };
  return { windowStart: timestamps[0], windowEnd: timestamps[timestamps.length - 1] };
}

/** Most recent FAIL-note cards, newest first -- concrete pointers instead of just the aggregate rework rate. */
function collectFailEvidence(tasks, limit = EVIDENCE_LIMIT) {
  const hits = [];
  for (const task of tasks) {
    const body = task.body ?? "";
    for (const match of body.matchAll(FAIL_NOTE_CAPTURE_RE)) {
      hits.push({ id: task.id, timestamp: match[1] });
    }
  }
  hits.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return hits.slice(0, limit);
}

/** Cards currently blocked on retry-cap exhaustion, with the timestamp of their final FAIL note if present. */
function collectRetryCapEvidence(tasks, limit = EVIDENCE_LIMIT) {
  const hits = [];
  for (const task of tasks) {
    const body = task.body ?? "";
    if (task.status !== "blocked" || !RETRY_CAP_TEXT_RE.test(body)) continue;
    const matches = [...body.matchAll(FAIL_NOTE_CAPTURE_RE)];
    const timestamp = matches.length ? matches[matches.length - 1][1] : undefined;
    hits.push({ id: task.id, timestamp });
  }
  hits.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
  return hits.slice(0, limit);
}

/** Cards with at least one orphan-reaper "## Recovered (" note, newest first. */
function collectRecoveredEvidence(tasks, limit = EVIDENCE_LIMIT) {
  const hits = [];
  for (const task of tasks) {
    const body = task.body ?? "";
    for (const match of body.matchAll(RECOVERED_NOTE_CAPTURE_RE)) {
      hits.push({ id: task.id, timestamp: match[1] });
    }
  }
  hits.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return hits.slice(0, limit);
}

/**
 * Pure decision function: given current stats and the task corpus, does a new improvement
 * proposal belong on the board right now? No state file -- the "baseline" and "last proposed at"
 * this reads back are embedded in the most recent auto-proposed card's own body (see
 * flowImprovementCard.js), so there is nothing that can desync from the actual card corpus.
 *
 * Two independent gates before any threshold is even considered:
 * - de-dupe: never fires while the most recent auto-proposed card is still open (not
 *   done/retired), so a persistently bad signal can't spam a new card while the last one is
 *   still unactioned.
 * - cadence: never fires within `minIntervalDays` of the last proposal's `proposed-at` marker,
 *   regardless of what the numbers say -- at most one proposal per week by default.
 *
 * Only genuinely evidenced, actionable signals fire a proposal (no pure-volume/interval trigger):
 * sustained rework rate, repeated retry-cap exhaustion, or repeated orphan-reaper recovery, each
 * gated by its own minimum-sample floor so a quiet week with a couple of blips stays silent.
 */
export function evaluateTrigger({
  stats,
  tasks,
  reworkThreshold,
  minReworkSample,
  minIntervalDays,
  minRetryCapBlocked,
  minRecovered,
  now = () => new Date()
}) {
  const latest = latestAutoProposedCard(tasks);
  if (latest && OPEN_STATUSES.has(latest.status)) {
    return null;
  }

  if (latest) {
    const proposedAt = extractProposedAt(latest.body);
    if (proposedAt) {
      const elapsedMs = now().getTime() - proposedAt.getTime();
      if (elapsedMs < minIntervalDays * DAY_MS) {
        return null;
      }
    }
  }

  const baselineDone = latest ? (extractBaselineDone(latest.body) ?? 0) : 0;

  if (stats.reworkSample >= minReworkSample && stats.reworkRate >= reworkThreshold) {
    const evidence = collectFailEvidence(tasks);
    return { reason: "rework-rate", reworkRate: stats.reworkRate, reworkSample: stats.reworkSample, baselineDone, evidence, ...windowFrom(evidence) };
  }

  if (stats.retryCapBlockedCount >= minRetryCapBlocked) {
    const evidence = collectRetryCapEvidence(tasks);
    return { reason: "retry-cap-blocked", retryCapBlockedCount: stats.retryCapBlockedCount, baselineDone, evidence, ...windowFrom(evidence) };
  }

  if (stats.recoveredTotal >= minRecovered) {
    const evidence = collectRecoveredEvidence(tasks);
    return { reason: "orphan-recovery", recoveredTotal: stats.recoveredTotal, baselineDone, evidence, ...windowFrom(evidence) };
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
  reworkThreshold = reworkThresholdFromEnv(),
  minReworkSample = minReworkSampleFromEnv(),
  minIntervalDays = minIntervalDaysFromEnv(),
  minRetryCapBlocked = minRetryCapBlockedFromEnv(),
  minRecovered = minRecoveredFromEnv(),
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
    const trigger = evaluateTrigger({
      stats,
      tasks,
      reworkThreshold,
      minReworkSample,
      minIntervalDays,
      minRetryCapBlocked,
      minRecovered,
      now
    });
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
