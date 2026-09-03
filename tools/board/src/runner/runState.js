import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Heartbeat freshness window for the run log's mtime, used two ways (see isRunLive): as the sole
 * check when a runstate has no usable pid (e.g. written by a future runner backend that doesn't
 * expose one), and as corroboration when a recorded pid's own liveness check reports "not
 * alive" -- in both cases the run's .runs/*.jsonl log path is consulted, since every streamed
 * agent event appends to that file. A file untouched for longer than this is treated as
 * abandoned. This is deliberately much smaller than DEFAULT_WEDGED_STALE_MS (45 min): a run
 * genuinely writing no output for a minute is unremarkable (see isRunWedged's own docstring on
 * long single tool calls), but it's exactly the corroborating signal this window needs -- a run
 * whose *only* evidence of life is "we don't have a working pid check" should require the log to
 * have moved recently, not merely at some point in the last 45 minutes.
 */
export const DEFAULT_HEARTBEAT_STALE_MS = 60_000;

export function runStatePath(runsDir, taskId) {
  return path.join(runsDir, `${taskId}.runstate.json`);
}

/**
 * Best-effort: liveness recording must never fail a run. Callers don't await error handling
 * here, matching the existing removeWorktree/PR-open "best effort" convention in
 * runOrchestrator.js -- worst case, a restart during this exact run falls back to the
 * pre-fix behavior (reaped) instead of crashing the run itself.
 */
export async function writeRunState({ runsDir, taskId, pid, runLogPath, now = () => new Date() }) {
  try {
    await fs.mkdir(runsDir, { recursive: true });
    const state = { pid, runLogPath, updatedAt: now().toISOString() };
    await fs.writeFile(runStatePath(runsDir, taskId), JSON.stringify(state), "utf8");
  } catch {
    // best-effort -- see docstring above
  }
}

/** Returns null (never throws) when the runstate file is missing, unreadable, or malformed. */
export async function readRunState({ runsDir, taskId }) {
  try {
    const raw = await fs.readFile(runStatePath(runsDir, taskId), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function clearRunState({ runsDir, taskId }) {
  try {
    await fs.unlink(runStatePath(runsDir, taskId));
  } catch {
    // already gone -- nothing to clean up
  }
}

/**
 * True iff `pid` is a real, currently-running process. `process.kill(pid, 0)` sends no
 * signal, just probes existence: ESRCH (or any other lookup failure) means dead, EPERM means
 * it exists but is owned by another user (still alive, just not ours to signal).
 */
export function isPidAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

/**
 * The liveness verdict a reap decision is built on. A recorded pid reporting *alive* is
 * definitive -- no reason to second-guess a hard OS-level answer. A pid reporting *not alive* is
 * NOT treated as definitive on its own: `isPidAlive`'s own contract only recognizes EPERM as
 * "alive under another user"; any other `process.kill(2)` failure (an unexpected errno, a
 * transient fork/exec-handoff hiccup) reads as dead with no second opinion. T-0276 and T-0287
 * were both reaped this way -- a human confirmed the recorded pid was alive and the run log had
 * been written to seconds earlier at the moment of the reap, so the pid check itself was the
 * false signal. A not-alive pid verdict is therefore corroborated against the run log's mtime
 * before concluding "dead", the same heartbeat proxy already used as the sole check when no pid
 * was recorded at all: a log still being appended to is direct evidence of life the pid check's
 * own false negative shouldn't override. Only when the log is ALSO stale (or missing/unreadable)
 * does a not-alive pid verdict stand -- that combination is what keeps a genuinely dead run
 * reapable (see isRunWedged for the converse case: alive pid, stale log).
 */
export async function isRunLive({
  state,
  now = Date.now(),
  heartbeatStaleMs = DEFAULT_HEARTBEAT_STALE_MS,
  isPidAliveFn = isPidAlive,
  statFn = fs.stat
}) {
  if (!state) return false;

  if (typeof state.pid === "number" && isPidAliveFn(state.pid)) {
    return true;
  }

  return isRunLogFresh({ runLogPath: state.runLogPath, now, heartbeatStaleMs, statFn });
}

async function isRunLogFresh({ runLogPath, now, heartbeatStaleMs, statFn }) {
  if (!runLogPath) return false;
  try {
    const stat = await statFn(runLogPath);
    return now - stat.mtimeMs < heartbeatStaleMs;
  } catch {
    return false;
  }
}

/**
 * Cross-check for a run whose recorded pid is genuinely alive (see `isRunLive`) but whose
 * `.jsonl` run log has stopped growing for longer than `wedgedStaleMs` -- exactly the T-0185
 * failure mode: a `claude` child that's still running (so `isRunLive` reports it as live,
 * correctly) with a grandchild subprocess (a headless Godot test that never called
 * `get_tree().quit()`) that will never produce another streamed event. Deliberately a *separate*
 * function from `isRunLive` rather than a change to it -- `isRunLive`'s pid-alive-is-definitive
 * contract is relied on elsewhere (see its own tests) and a wedged run is a distinct condition
 * ("alive but stuck"), not "dead".
 *
 * `wedgedStaleMs` defaults far larger than `DEFAULT_HEARTBEAT_STALE_MS` (that one only guards
 * the no-pid heartbeat fallback above) -- deliberately on the same order as
 * `runOrchestrator.js`'s own phase timeout, since a single long-running tool call (a big
 * `npm install`, a from-scratch `cmake` build) can legitimately produce no streamed event for
 * several minutes without being wedged. See `DEFAULT_WEDGED_STALE_MS`'s own doc comment for why
 * it's set slightly *above* the phase timeout default.
 */
export async function isRunWedged({ state, now = Date.now(), wedgedStaleMs = DEFAULT_WEDGED_STALE_MS, statFn = fs.stat }) {
  if (!state || !state.runLogPath) return false;
  try {
    const stat = await statFn(state.runLogPath);
    return now - stat.mtimeMs >= wedgedStaleMs;
  } catch {
    return false;
  }
}

/**
 * Slightly above `runOrchestrator.js`'s `DEFAULT_PHASE_TIMEOUT_MS` (40 min) by design: on a
 * live board process, the in-process phase timeout is what should normally catch a hung run
 * first (it fires from inside the very `runCard()` call that's stuck, so it can also update the
 * card's status). This wedged check is the backstop for when that in-process timer isn't
 * running at all -- most notably, a board restart loses every pending `setTimeout`, but a
 * `claude` child spawned `detached: true` (see `claudeCliRunner.js`) survives the restart with
 * the same pid, so `isRunLive` alone would trust it forever. Kept independent of (not imported
 * from) `runOrchestrator.js` to avoid a circular import -- `runOrchestrator.js` already imports
 * this module.
 */
export const DEFAULT_WEDGED_STALE_MS = 45 * 60 * 1000;

/** Grace period after SIGTERM before `killPidGroup` escalates to SIGKILL. */
export const DEFAULT_KILL_ESCALATION_MS = 10_000;

function sendSignal(killFn, pid, signal) {
  try {
    killFn(-pid, signal);
    return;
  } catch {
    // Not a process group leader (or already dead) -- fall back to the bare pid.
  }
  try {
    killFn(pid, signal);
  } catch {
    // Already dead -- nothing left to signal.
  }
}

/**
 * Kills a run by pid alone (no live `child` handle available -- this is used by the orphan
 * reaper against a run recorded in `tasks/.runs/*.runstate.json`, possibly from a process that
 * no longer exists). Same TERM-then-KILL escalation as `ClaudeCliRunner.kill()`, just built on
 * a raw pid instead of a `ChildProcess`: sends SIGTERM to the process group first (falling back
 * to the bare pid if it isn't a group leader), waits `escalationMs`, then sends SIGKILL if
 * `isPidAliveFn` still reports it alive. A no-op when `pid` isn't a number.
 */
export async function killPidGroup({
  pid,
  signal = "SIGTERM",
  escalationMs = DEFAULT_KILL_ESCALATION_MS,
  isPidAliveFn = isPidAlive,
  killFn = process.kill,
  delayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  if (typeof pid !== "number") return;

  sendSignal(killFn, pid, signal);
  await delayFn(escalationMs);
  if (isPidAliveFn(pid)) {
    sendSignal(killFn, pid, "SIGKILL");
  }
}
