import path from "node:path";
import { promises as fs } from "node:fs";
import { appendNote } from "./runOrchestrator.js";
import {
  readRunState,
  isRunLive,
  isRunWedged,
  isPidAlive,
  killPidGroup,
  DEFAULT_HEARTBEAT_STALE_MS,
  DEFAULT_WEDGED_STALE_MS
} from "./runState.js";
import * as gitOps from "./gitOps.js";

const ORPHAN_RECOVERY_DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** Statuses a run passes through while a card is actively being worked -- anything found here with no live run behind it is orphaned. */
export const ORPHANABLE_STATUSES = new Set(["in-progress", "validation"]);

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_GRACE_MS = 15_000;

const RECOVERY_NOTE_TEXT =
  "run did not complete (board restarted or process ended before a verdict); reset to blocked for re-run.";

const WEDGED_NOTE_TEXT =
  "run's process was alive but its log stopped growing (wedged/hung subprocess, e.g. a headless " +
  "test that never exited); process group killed, reset to blocked for re-run.";

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
 * must never undo the reap itself, so it's caught and logged. In db mode (`taskStoreKind ===
 * "db"`) this is always a no-op -- there is no tasks/*.md file to commit, the reap above already
 * wrote the recovery directly to the DB.
 */
async function commitReapedCard({ taskId, repoRoot, tasksDir, git, taskStoreKind }) {
  if (taskStoreKind === "db" || !repoRoot || !tasksDir || !git.autoCommitCardsOnCreateFromEnv()) return;
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

async function reapCard(store, hub, task, { repoRoot, tasksDir, git, taskStoreKind }, noteText = RECOVERY_NOTE_TEXT) {
  const updated = await store.update(task.id, {
    status: "blocked",
    body: appendNote(task.body, "Recovered", noteText)
  });
  hub.broadcast({ type: "changed", id: task.id, task: updated });
  await commitReapedCard({ taskId: task.id, repoRoot, tasksDir, git, taskStoreKind });
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
  wedgedStaleMs = DEFAULT_WEDGED_STALE_MS,
  isPidAliveFn = isPidAlive,
  readRunStateFn = readRunState,
  isRunLiveFn = isRunLive,
  isRunWedgedFn = isRunWedged,
  killPidGroupFn = killPidGroup,
  statFn = fs.stat,
  repoRoot = null,
  tasksDir = null,
  git = gitOps,
  taskStoreKind = "fs"
}) {
  const orphanSince = new Map();
  let timer = null;

  /**
   * Three-way liveness verdict for a card's recorded run, plus the raw inputs the verdict was
   * built on -- so a reap can log exactly why it fired (see `describeRunStatus` below) instead of
   * requiring a human to reconstruct it live, as happened for both T-0276 and T-0287. Verdicts:
   * "dead" (no runstate, or a recorded pid that's actually gone with no corroborating fresh run
   * log -- see `isRunLive` -- reap immediately), "wedged" (recorded pid is alive, per
   * `isRunLiveFn`, but its run log has gone stale well past `wedgedStaleMs` -- see
   * `isRunWedged`'s own docstring for why this is a distinct condition from "dead"), or "alive"
   * (genuinely still working). No runsDir configured (e.g. legacy test callers) preserves the
   * pre-fix behavior: always "dead".
   */
  async function checkRunStatus(taskId) {
    if (!runsDir) return { verdict: "dead", diagnostics: null };
    const state = await readRunStateFn({ runsDir, taskId });
    const diagnostics = await gatherDiagnostics(state);
    const live = await isRunLiveFn({ state, now: now(), heartbeatStaleMs, isPidAliveFn });
    if (!live) return { verdict: "dead", diagnostics };
    const wedged = await isRunWedgedFn({ state, now: now(), wedgedStaleMs });
    return { verdict: wedged ? "wedged" : "alive", diagnostics };
  }

  /** Raw liveness inputs for a card's recorded run, gathered once per checkRunStatus call so a reap decision can log exactly what it saw. Never throws -- a diagnostics gap must never block a reap decision. */
  async function gatherDiagnostics(state) {
    if (!state) return { pid: null, pidAlive: null, logAgeMs: null, heartbeatAgeMs: null };
    const pid = typeof state.pid === "number" ? state.pid : null;
    const pidAlive = pid === null ? null : isPidAliveFn(pid);
    let logAgeMs = null;
    if (state.runLogPath) {
      try {
        const stat = await statFn(state.runLogPath);
        logAgeMs = now() - stat.mtimeMs;
      } catch {
        // no run log to age -- logAgeMs stays null
      }
    }
    const heartbeatAgeMs = state.updatedAt ? now() - Date.parse(state.updatedAt) : null;
    return { pid, pidAlive, logAgeMs, heartbeatAgeMs };
  }

  /** Formats a reap decision's inputs for the journal -- see gatherDiagnostics. */
  function describeRunStatus(diagnostics) {
    if (!diagnostics) return "no runstate recorded";
    const { pid, pidAlive, logAgeMs, heartbeatAgeMs } = diagnostics;
    const fmt = (ms) => (ms === null ? "n/a" : `${Math.round(ms)}ms`);
    return `pid=${pid ?? "n/a"} pidAlive=${pidAlive ?? "n/a"} logAge=${fmt(logAgeMs)} heartbeatAge=${fmt(heartbeatAgeMs)}`;
  }

  /** Best-effort: a kill failure must never crash the sweep/startup pass itself. */
  async function killWedgedRun(taskId) {
    const state = await readRunStateFn({ runsDir, taskId });
    if (!state || typeof state.pid !== "number") return;
    try {
      await killPidGroupFn({ pid: state.pid });
    } catch (err) {
      logger.error(`assembled-board: failed to kill wedged run for ${taskId} (pid ${state.pid}): ${err.message}`);
    }
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
      const { verdict, diagnostics } = await checkRunStatus(task.id);
      if (verdict === "alive") {
        readopt(task.id);
        logger.log(`assembled-board: card ${task.id} still has a live run (survived restart) -- re-adopted, not reaped`);
        continue;
      }
      if (verdict === "wedged") {
        await killWedgedRun(task.id);
        await reapCard(store, hub, task, { repoRoot, tasksDir, git, taskStoreKind }, WEDGED_NOTE_TEXT);
        reaped.push(task.id);
        logger.log(
          `assembled-board: card ${task.id}'s recorded pid was alive but its run log was stale on startup -- ` +
            `killed and reset to blocked (was ${task.status}) [${describeRunStatus(diagnostics)}]`
        );
        continue;
      }
      await reapCard(store, hub, task, { repoRoot, tasksDir, git, taskStoreKind });
      reaped.push(task.id);
      logger.log(
        `assembled-board: recovered orphaned card ${task.id} on startup (was ${task.status}) [${describeRunStatus(diagnostics)}]`
      );
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
        // Still tracked as in-flight by this process -- normally left entirely alone. The one
        // exception is exactly T-0185: a card whose own runCard() is genuinely still awaiting
        // its child's exit, but that child (or a grandchild it spawned, e.g. a hung headless
        // Godot test) is wedged. A phase-level timeout (runOrchestrator.js) should normally
        // catch this on its own; this is the backstop for the gap while that timeout hasn't
        // fired yet. Only the process is killed here, never the card's status -- once the kill
        // lands, the owning runCard()'s own `_runPhase` observes the real exit and finishes the
        // card through its normal crash-handling path, exactly like any other process death.
        if (runsDir) {
          const { verdict, diagnostics } = await checkRunStatus(task.id);
          if (verdict === "wedged") {
            await killWedgedRun(task.id);
            logger.log(
              `assembled-board: card ${task.id} has a live pid but a stale run log while still tracked as active -- ` +
                `treated as wedged, process group killed (its own run will observe the exit and finish handling it) ` +
                `[${describeRunStatus(diagnostics)}]`
            );
          }
        }
        continue;
      }

      stillCandidate.add(task.id);
      if (!orphanSince.has(task.id)) {
        orphanSince.set(task.id, now());
      }

      if (now() - orphanSince.get(task.id) >= graceMs) {
        const { verdict: runStatus, diagnostics } = await checkRunStatus(task.id);
        if (runStatus === "alive") {
          readopt(task.id);
          stillCandidate.delete(task.id);
          logger.log(`assembled-board: card ${task.id} still has a live run (untracked by this process) -- re-adopted, not reaped`);
          continue;
        }
        if (runStatus === "wedged") {
          await killWedgedRun(task.id);
          await reapCard(store, hub, task, { repoRoot, tasksDir, git, taskStoreKind }, WEDGED_NOTE_TEXT);
          orphanSince.delete(task.id);
          reaped.push(task.id);
          logger.log(
            `assembled-board: card ${task.id}'s recorded pid was alive but its run log was stale -- ` +
              `killed and reset to blocked [${describeRunStatus(diagnostics)}]`
          );
          continue;
        }
        await reapCard(store, hub, task, { repoRoot, tasksDir, git, taskStoreKind });
        orphanSince.delete(task.id);
        reaped.push(task.id);
        logger.log(
          `assembled-board: recovered orphaned card ${task.id} (was ${task.status}, no active run) [${describeRunStatus(diagnostics)}]`
        );
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
