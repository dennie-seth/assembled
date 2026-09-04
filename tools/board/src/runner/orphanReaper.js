import path from "node:path";
import { promises as fs } from "node:fs";
import { appendNote } from "./runOrchestrator.js";
import {
  readRunState,
  isRunLive,
  isRunWedged,
  isPidAlive,
  clearRunState,
  killPidGroup,
  freshestRunLogMtimeForTask,
  DEFAULT_HEARTBEAT_STALE_MS,
  DEFAULT_WEDGED_STALE_MS
} from "./runState.js";
import * as gitOps from "./gitOps.js";

const ORPHAN_RECOVERY_DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** Statuses a run passes through while a card is actively being worked -- anything found here with no live run behind it is orphaned. */
export const ORPHANABLE_STATUSES = new Set(["in-progress", "validation"]);

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
/**
 * How long a card must have been sitting at in-progress/validation, unclaimed by the
 * orchestrator, before this module is willing to write its status.
 *
 * Raised from 15s to 90s on 2026-09-04 (T-0296). Against the 30s sweep interval, 15s bought a
 * launching card exactly ONE sweep of protection -- and the clock starts when the REAPER first
 * observes the card, not when its run began, so a card that reached in-progress just after a
 * sweep could be reaped on the next one. That is what happened to T-0302, twice:
 *
 *   16:45:47.898  status -> in-progress
 *   16:46:22.140  status + body -> blocked + "Recovered"      (34s later, one sweep)
 *
 * ...while the run was in fact healthy -- at 16:51 its pid was alive, its runstate heartbeat had
 * been refreshed 2s earlier, and its log had grown to 662 KB. The card read `blocked` throughout.
 *
 * 90s spans three sweeps, which comfortably covers the window between `activeCardIds.add` and a
 * run's liveness markers existing on disk (the first runstate heartbeat carries `pid: null` until
 * a child is actually spawned, and no run log exists at all until the first phase starts). It
 * costs nothing in the case this module exists for: a restart survivor has been abandoned for far
 * longer than 90s by the time anyone looks.
 */
const DEFAULT_GRACE_MS = 90_000;

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

/**
 * Formats a reap decision's inputs for the journal -- see gatherDiagnostics. Module-level rather
 * than closed over inside createOrphanReaper, because `reapCard` is module-level and is now the
 * single place a reap line is emitted. Pure: depends only on its argument.
 */
function describeRunStatus(diagnostics) {
  if (!diagnostics) return "no runstate recorded";
  const { pid, pidAlive, logAgeMs, heartbeatAgeMs } = diagnostics;
  const fmt = (ms) => (ms === null ? "n/a" : `${Math.round(ms)}ms`);
  return `pid=${pid ?? "n/a"} pidAlive=${pidAlive ?? "n/a"} logAge=${fmt(logAgeMs)} heartbeatAge=${fmt(heartbeatAgeMs)}`;
}

async function reapCard(
  store,
  hub,
  task,
  { repoRoot, tasksDir, git, taskStoreKind },
  noteText = RECOVERY_NOTE_TEXT,
  { logger = console, verdict = null, diagnostics = null, runsDir = null, clearRunStateFn = null } = {}
) {
  // Fix-plan item #2 (docs/reviews/2026-09-03-run-lifecycle-state-management.md): every reap
  // emits exactly one canonical line, from the single place a reap can happen, so no future call
  // site can add a silent path. Reaps were previously logged only at the call sites; on
  // 2026-09-03 eight fired against live runs and the journal recorded none of them, which is why
  // the defect went undiagnosed for a day and why T-0289 settled on the wrong root cause. A reap
  // rewrites a human-visible card -- it is never allowed to be silent.
  const updated = await store.update(task.id, {
    status: "blocked",
    body: appendNote(task.body, "Recovered", noteText)
  });
  logger.log(
    `orphan-reaper: reaped card ${task.id} (was ${task.status}) -- verdict=${verdict ?? "n/a"} ` +
      `[${describeRunStatus(diagnostics)}]`
  );
  // Fix-plan item #7 (docs/reviews/2026-09-03-run-lifecycle-state-management.md): a reap is a
  // verdict that this run is over, so the record describing it must not survive. Left in place it
  // becomes a stale dead-pid runstate that every later liveness check has to reason about -- the
  // leftover-runstate class, e.g. the T-0243 record that outlived its run by hours.
  // runOrchestrator.js clears its own on the way out of runCard(); this covers the runs that
  // ended without a runCard() left to do it (crash, kill, board restart), which are precisely the
  // runs the reaper exists for. Best-effort: clearRunState never throws.
  if (clearRunStateFn) await clearRunStateFn({ runsDir, taskId: task.id });
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
  clearRunStateFn = clearRunState,
  freshestRunLogMtimeForTaskFn = freshestRunLogMtimeForTask,
  statFn = fs.stat,
  readdirFn = fs.readdir,
  repoRoot = null,
  tasksDir = null,
  git = gitOps,
  taskStoreKind = "fs"
}) {
  const orphanSince = new Map();
  // Cards added to activeCardIds by *this* module's own readopt() -- as opposed to a genuine
  // runCard() span (runOrchestrator.js) tracking a card it spawned itself. The distinction matters
  // for the sweepOnce "dead" backstop below (see its own comment): a readopted card has no other
  // path back out of activeCardIds if its run later dies, so this module must be the one to notice.
  // A runCard()-tracked card already has that path (runOrchestrator.js's own activeCardIds.delete)
  // and must be left alone here even during a transient stale-runstate window between phases.
  const readoptedCardIds = new Set();
  let timer = null;

  /**
   * Fix-plan item #1 (docs/reviews/2026-09-03-run-lifecycle-state-management.md): the
   * orchestrator's in-memory `activeCardIds` (shared by reference -- see boardServer.js) is the
   * authority on whether a run is live. It is exact, where this module's pid/log-mtime inference
   * is lossy and goes stale by design during the normal gap between phases. A card the
   * orchestrator owns therefore has its status written by the orchestrator alone.
   *
   * "Owns" deliberately excludes cards THIS module readopted: those entered `activeCardIds` via
   * `readopt()` below and have no other exit (runOrchestrator.js's own `activeCardIds.delete`
   * lives inside a `runCard()` that does not exist for them), so the reaper must still be able to
   * release and reap its own entries -- that is T-0289/#314's fix and is preserved here. The rule
   * is "never touch an entry you did not add", not "never touch the Set".
   */
  function orchestratorOwns(taskId) {
    return Boolean(activeCardIds && activeCardIds.has(taskId) && !readoptedCardIds.has(taskId));
  }

  /** Removes only an id this module readopted. Never evicts an orchestrator-owned run. */
  function releaseReadoption(taskId) {
    if (!readoptedCardIds.has(taskId)) return false;
    readoptedCardIds.delete(taskId);
    if (activeCardIds && typeof activeCardIds.delete === "function") activeCardIds.delete(taskId);
    return true;
  }

  /**
   * Last check before any status write. `checkRunStatus` awaits (a file read plus one or more
   * stats), and the orphan-candidate path additionally spans a grace window measured across
   * sweeps -- a run can legitimately start in either gap, via POST /run or the auto-launch
   * poller. Re-reading the authority immediately before the write closes that race; without it a
   * reap lands on top of a run that started microseconds earlier, producing exactly the
   * live-run-marked-blocked symptom this fix exists to remove.
   */
  function suppressedByOwnership(taskId, verdict, diagnostics) {
    if (!orchestratorOwns(taskId)) return false;
    logger.log(
      `orphan-reaper: card ${taskId} would have been reaped (verdict=${verdict}) but the ` +
        `orchestrator still owns it -- suppressed, its own run will finish it ` +
        `[${describeRunStatus(diagnostics)}]`
    );
    return true;
  }

  /**
   * Four-way liveness verdict for a card's recorded run, plus the raw inputs the verdict was
   * built on -- so a reap can log exactly why it fired (see `describeRunStatus` below) instead of
   * requiring a human to reconstruct it live, as happened for both T-0276 and T-0287. Verdicts:
   *
   * - "alive": a recorded pid the OS confirms is running (`isPidAliveFn` returned true). The
   *   strongest signal available -- safe to trust indefinitely (e.g. `readopt` into
   *   `activeCardIds`).
   * - "deferred": there's evidence of life (a fresh run log -- either corroborating a
   *   pid the OS could NOT confirm, or standing in when the runstate itself is missing/
   *   unreadable/malformed, see below) but nothing as strong as a confirmed-alive pid. Neither
   *   reaped nor trusted forever -- stays a re-checkable candidate every sweep until it resolves
   *   one way or the other (see the "T-0289 correctness regression" tests in
   *   orphanReaper.test.js for why treating this the same as "alive" was itself a bug: a card
   *   readopted on corroboration alone had no path back to being reaped if its run then actually
   *   died, since nothing outside a genuine `runCard()` span ever calls `activeCardIds.delete`).
   * - "wedged": recorded pid is confirmed alive, but its run log has gone stale well past
   *   `wedgedStaleMs` -- see `isRunWedged`'s own docstring for why this is a distinct condition
   *   from "dead" (only meaningful once a pid is actually confirmed; an unconfirmed pid falls
   *   under "deferred"/"dead" instead, since there's no live process to call wedged).
   * - "dead": no evidence of life at all -- reap immediately.
   *
   * No runsDir configured (e.g. legacy test callers) preserves the pre-fix behavior: always
   * "dead".
   */
  async function checkRunStatus(taskId) {
    if (!runsDir) return { verdict: "dead", diagnostics: null };
    const state = await readRunStateFn({ runsDir, taskId });

    if (!state) {
      // Candidate #2 from the card: the runstate file was missing, unreadable, or malformed
      // (readRunState returns null for all three -- see its own docstring), so there's no
      // `runLogPath` to consult via isRunLive. Fall back to finding the task's run log directly
      // by its deterministic `${taskId}-<timestamp>.jsonl` naming (see freshestRunLogMtimeForTask)
      // -- a log still being written is corroborating evidence of life even when the runstate
      // record of *why* can't be trusted.
      const mtimeMs = await freshestRunLogMtimeForTaskFn({ runsDir, taskId, readdirFn, statFn });
      const logAgeMs = mtimeMs === null ? null : now() - mtimeMs;
      const diagnostics = { pid: null, pidAlive: null, logAgeMs, heartbeatAgeMs: null };
      const corroborated = logAgeMs !== null && logAgeMs < heartbeatStaleMs;
      return { verdict: corroborated ? "deferred" : "dead", diagnostics };
    }

    const diagnostics = await gatherDiagnostics(state);
    const pidConfirmedAlive = typeof state.pid === "number" && isPidAliveFn(state.pid);
    const live = await isRunLiveFn({ state, now: now(), heartbeatStaleMs, isPidAliveFn });
    if (!live) return { verdict: "dead", diagnostics };
    if (!pidConfirmedAlive) return { verdict: "deferred", diagnostics };
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
    // Diagnostic-only, like `updatedAt` itself -- see writeRunState's docstring. Surfaced in the
    // journal for a human to see, never consulted by the verdict above.
    const heartbeatAgeMs = state.updatedAt ? now() - Date.parse(state.updatedAt) : null;
    return { pid, pidAlive, logAgeMs, heartbeatAgeMs };
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
    readoptedCardIds.add(taskId);
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
      if (verdict === "deferred") {
        // Weaker-than-confirmed-alive evidence of life (see checkRunStatus's docstring) -- not
        // reaped, but also NOT readopted: readopt() has no way back once activeCardIds contains
        // this taskId, so a card only ever readopted on corroboration would be stranded forever
        // if its run then genuinely died. Leaving status/activeCardIds untouched lets sweepOnce's
        // normal orphan-candidate grace window (task not in activeCardIds, status still
        // in-progress/validation) pick it up and keep re-evaluating it on its own schedule.
        logger.log(
          `assembled-board: card ${task.id}'s recorded run state is inconclusive but its run log is still fresh -- ` +
            `deferring reap, leaving status as-is for the next sweep to re-evaluate [${describeRunStatus(diagnostics)}]`
        );
        continue;
      }
      if (verdict === "wedged") {
        if (suppressedByOwnership(task.id, verdict, diagnostics)) continue;
        await killWedgedRun(task.id);
        await reapCard(store, hub, task, { repoRoot, tasksDir, git, taskStoreKind }, WEDGED_NOTE_TEXT, {
          logger,
          verdict,
          diagnostics,
          runsDir,
          clearRunStateFn
        });
        reaped.push(task.id);
        logger.log(
          `assembled-board: card ${task.id}'s recorded pid was alive but its run log was stale on startup -- ` +
            `killed and reset to blocked (was ${task.status}) [${describeRunStatus(diagnostics)}]`
        );
        continue;
      }
      if (suppressedByOwnership(task.id, verdict, diagnostics)) continue;
      await reapCard(store, hub, task, { repoRoot, tasksDir, git, taskStoreKind }, RECOVERY_NOTE_TEXT, {
        logger,
        verdict,
        diagnostics,
        runsDir,
        clearRunStateFn
      });
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
          } else if (verdict === "dead" && orchestratorOwns(task.id)) {
            // Our inference says "dead" for a card the orchestrator owns -- that is this module
            // being wrong (a since-exited pid from the previous phase alongside a quiet log), not
            // a dead run. Suppress, and say so loudly: a silently suppressed reap is as invisible
            // as a silently fired one, and both cost us a day.
            suppressedByOwnership(task.id, verdict, diagnostics);
          } else if (verdict === "dead" && readoptedCardIds.has(task.id)) {
            // Backstop for a card that reached activeCardIds via readopt() (a confirmed-alive
            // pid at readopt time -- legitimate at the time) whose run has since genuinely ended
            // with no runCard() in this process ever tracking it to notice: a readopted card's
            // activeCardIds membership has no other exit path (runOrchestrator.js's own
            // activeCardIds.delete lives inside a runCard() that doesn't exist for it), so
            // without this it would be stranded at in-progress/validation forever, pinning
            // hasActiveRuns() true. Only fires on a genuine "dead" verdict (confirmed pid gone,
            // no corroborating fresh log) -- never on "deferred", which is left alone here same
            // as anywhere else. Gated on readoptedCardIds (VALIDATION FAIL #2's fix): a card
            // added to activeCardIds by a genuine runCard() span already has its own exit path
            // and must never have its status touched here, even during the normal quiet window
            // between runOrchestrator.js's per-phase writeRunState calls (e.g. mid PR-open,
            // which can legitimately run past DEFAULT_HEARTBEAT_STALE_MS) when the runstate on
            // disk can transiently hold a since-exited child's pid alongside a stale-looking log.
            releaseReadoption(task.id);
            await reapCard(store, hub, task, { repoRoot, tasksDir, git, taskStoreKind }, RECOVERY_NOTE_TEXT, {
              logger,
              verdict,
              diagnostics,
              runsDir,
              clearRunStateFn
            });
            reaped.push(task.id);
            logger.log(
              `assembled-board: card ${task.id} was tracked as active (likely re-adopted after a confirmed-alive pid ` +
                `check that has since gone dead) but its run is now confirmed dead -- reaped [${describeRunStatus(diagnostics)}]`
            );
          }
        }
        continue;
      }

      stillCandidate.add(task.id);
      if (!orphanSince.has(task.id)) {
        orphanSince.set(task.id, now());
      }

      const waited = now() - orphanSince.get(task.id);
      if (waited < graceMs) {
        // #322 made every reap and every ownership suppression loud, but this branch -- "seen at
        // in-progress, not yet old enough to judge" -- stayed silent, so a card being held (and
        // then reaped a sweep later) left no trace at all. On 2026-09-04 that is why T-0302's
        // false reap ran invisibly for hours: nothing in the journal mentioned the card between
        // its launch and its blocked status. Every sweep decision now says something.
        logger.log(
          `orphan-reaper: card ${task.id} (${task.status}) is inside the launch grace window ` +
            `(${waited}ms of ${graceMs}ms) -- left alone, will re-evaluate next sweep`
        );
      }

      if (waited >= graceMs) {
        const { verdict: runStatus, diagnostics } = await checkRunStatus(task.id);
        if (runStatus === "alive") {
          readopt(task.id);
          stillCandidate.delete(task.id);
          logger.log(`assembled-board: card ${task.id} still has a live run (untracked by this process) -- re-adopted, not reaped`);
          continue;
        }
        if (runStatus === "deferred") {
          // Left as a candidate (orphanSince untouched, stillCandidate already holds it) so the
          // very next sweep re-checks it -- if the log keeps moving it keeps deferring
          // indefinitely (see the "T-0289 correctness regression" tests), and if it goes stale
          // the verdict becomes "dead" and it reaps normally.
          logger.log(
            `assembled-board: card ${task.id}'s recorded run state is inconclusive but its run log is still fresh -- ` +
              `deferring reap, will recheck next sweep [${describeRunStatus(diagnostics)}]`
          );
          continue;
        }
        if (runStatus === "wedged") {
          if (suppressedByOwnership(task.id, runStatus, diagnostics)) continue;
          await killWedgedRun(task.id);
          await reapCard(store, hub, task, { repoRoot, tasksDir, git, taskStoreKind }, WEDGED_NOTE_TEXT, {
            logger,
            verdict: runStatus,
            diagnostics,
            runsDir,
            clearRunStateFn
          });
          orphanSince.delete(task.id);
          reaped.push(task.id);
          logger.log(
            `assembled-board: card ${task.id}'s recorded pid was alive but its run log was stale -- ` +
              `killed and reset to blocked [${describeRunStatus(diagnostics)}]`
          );
          continue;
        }
        if (suppressedByOwnership(task.id, runStatus, diagnostics)) continue;
        await reapCard(store, hub, task, { repoRoot, tasksDir, git, taskStoreKind }, RECOVERY_NOTE_TEXT, {
          logger,
          verdict: runStatus,
          diagnostics,
          runsDir,
          clearRunStateFn
        });
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
