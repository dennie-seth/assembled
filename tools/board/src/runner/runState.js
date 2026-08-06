import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Heartbeat freshness window used only when a runstate has no usable pid (e.g. written by
 * a future runner backend that doesn't expose one) -- the run's .runs/*.jsonl log path is
 * consulted instead, since every streamed agent event appends to that file. A file untouched
 * for longer than this is treated as abandoned.
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
 * The liveness verdict a reap decision is built on. A recorded pid is definitive in either
 * direction (alive or dead -- no reason to second-guess a hard OS-level answer). Only when no
 * pid was recorded at all does this fall back to the run log's mtime as a heartbeat proxy.
 */
export async function isRunLive({
  state,
  now = Date.now(),
  heartbeatStaleMs = DEFAULT_HEARTBEAT_STALE_MS,
  isPidAliveFn = isPidAlive,
  statFn = fs.stat
}) {
  if (!state) return false;

  if (typeof state.pid === "number") {
    return isPidAliveFn(state.pid);
  }

  if (!state.runLogPath) return false;
  try {
    const stat = await statFn(state.runLogPath);
    return now - stat.mtimeMs < heartbeatStaleMs;
  } catch {
    return false;
  }
}
