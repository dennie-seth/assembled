import path from "node:path";
import { appendNote } from "./runOrchestrator.js";
import { readRunState, isRunLive, isPidAlive, DEFAULT_HEARTBEAT_STALE_MS } from "./runState.js";
import * as gitOps from "./gitOps.js";

const ORPHAN_RECOVERY_DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** Statuses a run passes through while a card is actively being worked -- anything found here with no live run behind it is orphaned. */
export const ORPHANABLE_STATUSES = new Set(["in-progress", "validation"]);

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_GRACE_MS = 15_000;

const RECOVERY_NOTE_TEXT =
  "run did not complete (board restarted or process ended before a verdict); reset to blocked for re-run.";

/** AUTO_RECOVER_ORPHANED_RUNS env var: default ON; set to "0"/"false"/"off"/"no" (any case) to disable orphan recovery. */
export function orphanRecoveryEnabledFromEnv() {
  return !ORPHAN_RECOVERY_DISABLE_VALUES.has((process.env.AUTO_RECOVER_ORPHANED_RUNS ?? "").toLowerCase());
}

/**
 * Commits the reaped card file to repoRoot, the same way runOrchestrator.js's
 * `_updateAndBroadcast` does (see its docstring) -- recovery is just another in-run status
 * write, so it left the same dirty-tree trail that broke the Done-triggered `pullDevelop`.
 * Opt-in via `repoRoot`/`tasksDir`: omitting them disables committing entirely, matching
 * httpApi.js's `if (repoRoot && tasksDir && ...)` guard. Best-effort -- a commit failure
 * must never undo the reap itself, so it's caught and logged.
 */
async function commitReapedCard({ taskId, repoRoot, tasksDir, git }) {
  if (!repoRoot || !tasksDir || !git.autoCommitCardsOnCreateFromEnv()) return;
  try {
    const relativePath = path.relative(repoRoot, path.join(tasksDir, `${taskId}.md`));
    await git.commitTaskFile({
      repoRoot,
      filePath: relativePath,
      message: `chore(board): update card ${taskId} (status, body)`
    });
  } catch (err) {
    console.warn(`Board: failed to commit orphan recovery for ${taskId} (leaving it untracked):`, err.message);
  }
}

async function reapCard(store, hub, task, { repoRoot, tasksDir, git }) {
  const updated = await store.update(task.id, {
    status: "blocked",
    body: appendNote(task.body, "Recovered", RECOVERY_NOTE_TEXT)
  });
  hub.broadcast({ type: "changed", id: task.id, task: updated });
  await commitReapedCard({ taskId: task.id, repoRoot, tasksDir, git });
  return updated;
}

/**
 * Backstop for runs that end without a clean status transition -- a crashed
 * reviewer, a killed process, or the board restarting mid-run all leave a
 * card stuck at `in-progress`/`validation` forever with nothing left alive
 * to move it. Two entry points cover the two ways that happens:
 *
 * - `reapOnStartup`: a fresh process has zero active runs *in memory* by
 *   definition, so `activeCardIds` alone can't tell a genuinely-dead run
 *   from one whose `claude` child process (spawned `detached: true`,
 *   see claudeCliRunner.js) survived a `node --watch` relaunch or board
 *   restart -- that child is not in this process's process group, so it
 *   keeps running with the same pid across the restart. Before reaping,
 *   check `runState.js`'s persisted `{pid, runLogPath}` for the card: a
 *   live pid (`isPidAlive`) means the run is genuinely still going, so the
 *   card is left at its current status and re-adopted into `activeCardIds`
 *   instead of being reset. Only a card with no evidence of a live process
 *   is reaped, immediately, no grace window needed.
 * - `sweepOnce` (run on an interval via `start`/`stop`): covers a process
 *   crashing while the board itself stays up. A card only reaches
 *   `in-progress`/`validation` after `RunOrchestrator.runCard` has already
 *   added it to `activeCardIds` (see runOrchestrator.js), so a card in one
 *   of those statuses but absent from `activeCardIds` has no *tracked* live
 *   run behind it. The grace window (tracked per-card via `orphanSince`)
 *   exists as a safety margin against sweep-tick timing; once it elapses,
 *   the same pid/heartbeat liveness check as `reapOnStartup` runs before
 *   actually reaping, so a card whose process survived independently of
 *   this process's bookkeeping (the same restart scenario) is re-adopted
 *   rather than reaped.
 *
 * Recovery only ever changes `status` (+ appends a note) -- branches,
 * worktrees, and everything else the card carries are left untouched so the
 * existing re-run-continues path can pick the card back up.
 */
export function createOrphanReaper({
  store,
  hub,
  activeCardIds,
  enabled = orphanRecoveryEnabledFromEnv(),
  graceMs = DEFAULT_GRACE_MS,
  intervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  now = () => Date.now(),
  logger = console,
  runsDir = null,
  heartbeatStaleMs = DEFAULT_HEARTBEAT_STALE_MS,
  isPidAliveFn = isPidAlive,
  readRunStateFn = readRunState,
  isRunLiveFn = isRunLive,
  repoRoot = null,
  tasksDir = null,
  git = gitOps
}) {
  const orphanSince = new Map();
  let timer = null;

  /** No runsDir configured (e.g. legacy test callers) preserves the pre-fix behavior: always reap. */
  async function isCardStillLive(taskId) {
    if (!runsDir) return false;
    const state = await readRunStateFn({ runsDir, taskId });
    return isRunLiveFn({ state, now: now(), heartbeatStaleMs, isPidAliveFn });
  }

  function readopt(taskId) {
    orphanSince.delete(taskId);
    if (activeCardIds && typeof activeCardIds.add === "function") {
      activeCardIds.add(taskId);
    }
  }

  async function reapOnStartup() {
    if (!enabled) return [];
    const tasks = await store.list();
    const reaped = [];
    for (const task of tasks) {
      if (!ORPHANABLE_STATUSES.has(task.status)) continue;
      if (await isCardStillLive(task.id)) {
        readopt(task.id);
        logger.log(`assembled-board: card ${task.id} still has a live run (survived restart) -- re-adopted, not reaped`);
        continue;
      }
      await reapCard(store, hub, task, { repoRoot, tasksDir, git });
      reaped.push(task.id);
      logger.log(`assembled-board: recovered orphaned card ${task.id} on startup (was ${task.status})`);
    }
    return reaped;
  }

  async function sweepOnce() {
    if (!enabled) return [];
    const tasks = await store.list();
    const stillCandidate = new Set();
    const reaped = [];

    for (const task of tasks) {
      if (!ORPHANABLE_STATUSES.has(task.status)) continue;
      if (activeCardIds.has(task.id)) {
        orphanSince.delete(task.id);
        continue;
      }

      stillCandidate.add(task.id);
      if (!orphanSince.has(task.id)) {
        orphanSince.set(task.id, now());
      }

      if (now() - orphanSince.get(task.id) >= graceMs) {
        if (await isCardStillLive(task.id)) {
          readopt(task.id);
          stillCandidate.delete(task.id);
          logger.log(`assembled-board: card ${task.id} still has a live run (untracked by this process) -- re-adopted, not reaped`);
          continue;
        }
        await reapCard(store, hub, task, { repoRoot, tasksDir, git });
        orphanSince.delete(task.id);
        reaped.push(task.id);
        logger.log(`assembled-board: recovered orphaned card ${task.id} (was ${task.status}, no active run)`);
      }
    }

    for (const id of orphanSince.keys()) {
      if (!stillCandidate.has(id)) orphanSince.delete(id);
    }

    return reaped;
  }

  function start() {
    if (!enabled || timer) return;
    timer = setInterval(() => {
      sweepOnce().catch((err) => logger.error(`assembled-board: orphan sweep failed: ${err.message}`));
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
    reapOnStartup,
    sweepOnce,
    start,
    stop,
    get enabled() {
      return enabled;
    }
  };
}
