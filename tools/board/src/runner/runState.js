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
 *
 * `updatedAt` IS a real heartbeat as of fix-plan item #3
 * (docs/reviews/2026-09-03-run-lifecycle-state-management.md) and IS read by `isRunLive`.
 *
 * It used to mean only "a phase started at some point": written once per phase and deliberately
 * never consulted, because a field refreshed that rarely cannot distinguish a live run from a
 * dead one. That left the run log's mtime as the only fallback evidence, and a run is legitimately
 * silent between phases -- implementer child exits, then verifyRouter / git sync / PR-open, then
 * the reviewer spawns -- so a healthy run looked dead for the whole gap. That is the window the
 * review identifies as the actual cause of the false reaps.
 *
 * `RunOrchestrator` now refreshes this field on a timer for the entire `runCard` span, independent
 * of phase boundaries, so freshness here means "the process that owns this run was alive moments
 * ago". Reading it is therefore sound, and the old trap -- a field that looks like a heartbeat but
 * is never consulted -- is resolved by making it genuinely both.
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
 * transient fork/exec-handoff hiccup) reads as dead with no second opinion.
 *
 * Root cause, T-0276/T-0287 (evidence, not a restated guess -- see the card's own candidate list
 * for what this rules out): both incidents' card bodies recorded the runstate's *actual field
 * values* at the moment of the false reap (a pid, and an `updatedAt` from launch) -- meaning the
 * runstate file was demonstrably present and successfully parsed, not null/mid-write. That rules
 * out "state was null/partial and the pid branch never ran" (the card's candidate #2) for these
 * two incidents specifically -- see the `!state` guard below, which never reaches the pid check
 * at all when it fires, so a null state can't produce a *pid*-branch false reap in the first
 * place. It also rules out "a second, different reap path" (candidate #4): the card's own
 * "OBSERVED LIVE 2026-09-03" human comment records, while watching a run live, that its card
 * "oscillated: blocked -> the reaper reaps a live run, validation -> the orchestrator overwrites
 * it at the next phase transition, blocked -> the reaper reaps it AGAIN on the next sweep",
 * attributing that directly to `DEFAULT_SWEEP_INTERVAL_MS` (30s) combined with a heartbeat that's
 * never refreshed past `DEFAULT_HEARTBEAT_STALE_MS` (60s). (Don't confuse this with the gaps
 * between the card's separate "## Recovered" notes, e.g. ~5m14s apart -- those mark the start of
 * unrelated later orchestrator runs re-attempting the card, not consecutive sweeps within one
 * run, and are not the evidence being cited here.) `reapOnStartup` only runs once per process
 * start, so a per-sweep-interval oscillation within a single live run can only come from
 * `sweepOnce` re-running the identical liveness check on an interval, not from a restart-triggered
 * path.
 * "The sweep operating on a stale in-memory copy" (candidate #3) is also ruled out by inspection:
 * `checkRunStatus` (orphanReaper.js) calls `readRunStateFn` fresh on every invocation, with no
 * memoization anywhere in this module or its caller. That leaves candidate #1 -- `isPidAlive`
 * returning a false negative -- as the only one of the card's four candidates not eliminated by
 * either the incidents' own recorded evidence or by tracing the code's actual control flow; this
 * environment (WSL2's syscall translation layer, see docs/env-inventory.md) is a plausible-but-
 * unconfirmed source for an unexpected `process.kill(2)` errno, though the reap loop itself is
 * covered by corroboration below regardless of which specific errno was involved.
 *
 * A not-alive pid verdict is therefore corroborated against the run log's mtime before
 * concluding "dead", the same heartbeat proxy already used as the sole check when no pid was
 * recorded at all: a log still being appended to is direct evidence of life the pid check's own
 * false negative shouldn't override. Only when the log is ALSO stale (or missing/unreadable) does
 * a not-alive pid verdict stand -- that combination is what keeps a genuinely dead run reapable
 * (see isRunWedged for the converse case: alive pid, stale log).
 *
 * This function's own boolean contract is unchanged by T-0289's regression fix: it still answers
 * "is there evidence of life" without distinguishing *how strong* that evidence is. The caller
 * (orphanReaper.js's `checkRunStatus`) is what now splits a `true` result into "alive" (pid
 * confirmed by the OS, safe to trust indefinitely -- e.g. readopt into `activeCardIds`) versus
 * "deferred" (corroborated only by the log, weaker evidence that must stay re-checkable rather
 * than being trusted forever) -- see its own docstring for why that distinction was necessary.
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

  // Fix-plan item #3: a heartbeat refreshed for the whole runCard span (see writeRunState's
  // docstring) is direct evidence that the owning process was alive moments ago. Checked before
  // the log-mtime fallback because it stays fresh across the inter-phase gap, where the log
  // legitimately goes quiet -- that gap is where healthy runs were being judged dead. A STALE
  // heartbeat proves nothing on its own, so it never turns a dead run live: the log check below
  // still runs, and a genuinely abandoned runstate still reaps.
  if (isHeartbeatFresh({ updatedAt: state.updatedAt, now, heartbeatStaleMs })) {
    return true;
  }

  return isRunLogFresh({ runLogPath: state.runLogPath, now, heartbeatStaleMs, statFn });
}

/** True when `updatedAt` parses and is younger than the staleness window. Never throws. */
function isHeartbeatFresh({ updatedAt, now, heartbeatStaleMs }) {
  if (!updatedAt) return false;
  const written = Date.parse(updatedAt);
  if (Number.isNaN(written)) return false;
  return now - written < heartbeatStaleMs;
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
 * Finds a task's most recently modified run log by taskId prefix, for the one case `isRunLive`
 * can't help with: the runstate file itself is missing, unreadable, or malformed
 * (`readRunState` returns null for all three -- see its own docstring), so there's no
 * `runLogPath` on it to consult. `runLog.js` always names a task's log
 * `${taskId}-<timestamp>.jsonl` -- the prefix is deterministic even though the timestamp suffix
 * isn't, and a run can have several matching files across its lifetime (one per phase; see
 * runOrchestrator.js's `_runPhase`), so the freshest one is used. Returns null (never throws)
 * when `runsDir` can't be read or nothing matches.
 */
export async function freshestRunLogMtimeForTask({ runsDir, taskId, readdirFn = fs.readdir, statFn = fs.stat }) {
  let entries;
  try {
    entries = await readdirFn(runsDir);
  } catch {
    return null;
  }
  const prefix = `${taskId}-`;
  let freshestMtimeMs = null;
  for (const name of entries) {
    if (!name.endsWith(".jsonl") || !name.startsWith(prefix)) continue;
    try {
      const stat = await statFn(path.join(runsDir, name));
      if (freshestMtimeMs === null || stat.mtimeMs > freshestMtimeMs) freshestMtimeMs = stat.mtimeMs;
    } catch {
      // Unreadable entry (deleted mid-scan, permissions) -- skip it, don't let one bad stat
      // block the others.
    }
  }
  return freshestMtimeMs;
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
