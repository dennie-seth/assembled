import { appendNote } from "./runOrchestrator.js";

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

async function reapCard(store, hub, task) {
  const updated = await store.update(task.id, {
    status: "blocked",
    body: appendNote(task.body, "Recovered", RECOVERY_NOTE_TEXT)
  });
  hub.broadcast({ type: "changed", id: task.id, task: updated });
  return updated;
}

/**
 * Backstop for runs that end without a clean status transition -- a crashed
 * reviewer, a killed process, or the board restarting mid-run all leave a
 * card stuck at `in-progress`/`validation` forever with nothing left alive
 * to move it. Two entry points cover the two ways that happens:
 *
 * - `reapOnStartup`: a fresh process has zero active runs by definition, so
 *   any card already sitting at `in-progress`/`validation` when the board
 *   boots belongs to a run that died with the previous process. Reap it
 *   immediately, no grace window needed.
 * - `sweepOnce` (run on an interval via `start`/`stop`): covers a process
 *   crashing while the board itself stays up. A card only reaches
 *   `in-progress`/`validation` after `RunOrchestrator.runCard` has already
 *   added it to `activeCardIds` (see runOrchestrator.js), so a card in one
 *   of those statuses but absent from `activeCardIds` has no live run behind
 *   it. The grace window (tracked per-card via `orphanSince`) exists purely
 *   as a safety margin against sweep-tick timing, not because that ordering
 *   can actually race.
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
  logger = console
}) {
  const orphanSince = new Map();
  let timer = null;

  async function reapOnStartup() {
    if (!enabled) return [];
    const tasks = await store.list();
    const reaped = [];
    for (const task of tasks) {
      if (!ORPHANABLE_STATUSES.has(task.status)) continue;
      await reapCard(store, hub, task);
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
        await reapCard(store, hub, task);
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
