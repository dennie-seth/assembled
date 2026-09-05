import { promises as fs } from "node:fs";

/**
 * How often `RunOrchestrator._runPhase` polls the filesystem-liveness watched set (T-0308:
 * subagent-owned tool calls don't forward the CLI's `tool_progress` heartbeat up the parent
 * stream, so stdout alone can go silent for a long subagent job's entire span even while it's
 * demonstrably alive on disk). Deliberately a fixed cadence, not derived from
 * `inactivityTimeoutMs` -- that keeps the probe's own cost predictable regardless of how a
 * deployment tunes the inactivity budget. 30s gives several chances to observe growth well
 * inside even a tightened budget, comfortably faster than the ~95s-per-checkpoint cadence
 * measured on the T-0274 training job this card exists to catch.
 */
export const DEFAULT_LIVENESS_PROBE_INTERVAL_MS = 30_000;

/**
 * Explicit, bounded watched set for the filesystem-liveness probe -- deliberately NOT a
 * recursive walk of the whole worktree (that would be an unbounded cost per probe on a large
 * checkout). A directory's mtime advances whenever a direct child is created/removed/renamed
 * inside it, so watching the worktree root catches an agent creating output directly there;
 * watching the run's own `.jsonl` log catches every streamed event, on its own cadence
 * independent of the CLI's subagent-heartbeat-forwarding gap this card works around. Falsy
 * entries (a run log path not yet known, a worktree not yet recorded) are dropped rather than
 * handed to the prober.
 */
export function watchedLivenessPaths({ worktreeDir, runLogPath }) {
  return [worktreeDir, runLogPath].filter(Boolean);
}

/**
 * Freshest `{ path, mtimeMs }` across the watched set, or null when nothing in it is statable
 * right now. Never throws -- a missing/unreadable path (worktree not yet created, log not yet
 * flushed, a `statFn` that rejects or even throws synchronously) degrades to "no evidence from
 * that path", not a crash, so this can never itself hang or take down the phase it's watching.
 */
export async function probeLivenessMtime({ worktreeDir, runLogPath, statFn = fs.stat }) {
  let freshest = null;
  for (const target of watchedLivenessPaths({ worktreeDir, runLogPath })) {
    try {
      const stat = await statFn(target);
      if (!freshest || stat.mtimeMs > freshest.mtimeMs) freshest = { path: target, mtimeMs: stat.mtimeMs };
    } catch {
      // missing/unreadable/threw -- skip, degrade to no evidence from this one path
    }
  }
  return freshest;
}
