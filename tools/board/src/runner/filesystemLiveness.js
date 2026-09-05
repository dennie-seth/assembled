import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_PRESERVED_ARTIFACT_PATHS } from "./artifactPreservation.js";

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
 * Explicit, bounded watched set for the filesystem-liveness probe.
 *
 * `dirs` is the worktree root plus each `outputSubpaths` entry joined onto it -- deliberately
 * reusing `DEFAULT_PRESERVED_ARTIFACT_PATHS` (artifactPreservation.js) as the default rather than
 * inventing a second list: it is already the repo's answer to "where does a card's own long-
 * running work actually land" (LoRA checkpoint dirs, generated asset output, fetched corpora),
 * kept alive across a worktree reclaim for exactly the same reason this probe needs to see it --
 * it is expensive to (re)produce and monotonic. The worktree root alone only advances its own
 * mtime when a DIRECT child is created/removed/renamed, which misses every nested write a
 * subagent makes two or more directories down (T-0274's shape); each `probeLivenessMtime` call
 * below does a *shallow* (one level, non-recursive) readdir+stat of every directory in this set,
 * so a checkpoint file written inside `assets/out/lora/<run>/` is visible without ever walking
 * the whole checkout.
 *
 * `files` is just the run's own `.jsonl` log, stat'd directly (no readdir needed for a single
 * file) -- retained as a second, independent signal even though it is largely redundant with
 * stdout (both derive from the same NDJSON events), since keeping it costs one extra `stat` and
 * degrades safely to no evidence when the run log path isn't known yet.
 *
 * Falsy entries (a run log path not yet known, a worktree not yet recorded) are dropped rather
 * than handed to the prober.
 */
export function watchedLivenessPaths({ worktreeDir, runLogPath, outputSubpaths = DEFAULT_PRESERVED_ARTIFACT_PATHS }) {
  const dirs = worktreeDir ? [worktreeDir, ...outputSubpaths.map((sub) => path.join(worktreeDir, sub))] : [];
  const files = [runLogPath].filter(Boolean);
  return { dirs, files };
}

/**
 * Freshest `{path, mtimeMs}` among `dir` itself and its direct (one-level, non-recursive)
 * entries. Stat-ing `dir` itself catches a freshly-created-but-still-empty output directory (no
 * entries yet, but its own creation is evidence); the entry scan catches everything written
 * inside it since. Never throws: a missing/unreadable directory (readdir fails), or a single
 * unreadable/vanished entry inside it (stat fails), degrades to whatever evidence was already
 * found -- one bad entry never blanks the rest of the scan.
 */
async function freshestEntryMtime({ dir, statFn, readdirFn }) {
  let freshest = null;
  try {
    const stat = await statFn(dir);
    freshest = { path: dir, mtimeMs: stat.mtimeMs };
  } catch {
    // dir itself missing/unreadable -- no evidence from the dir entry; entries (if any are even
    // listable) are still tried below.
  }
  let entries;
  try {
    entries = await readdirFn(dir);
  } catch {
    return freshest;
  }
  for (const name of entries) {
    const entryPath = path.join(dir, name);
    try {
      const stat = await statFn(entryPath);
      if (!freshest || stat.mtimeMs > freshest.mtimeMs) freshest = { path: entryPath, mtimeMs: stat.mtimeMs };
    } catch {
      // vanished mid-scan / unreadable -- skip, don't let one bad entry block the rest
    }
  }
  return freshest;
}

/**
 * Freshest `{ path, mtimeMs }` across the watched set (`watchedLivenessPaths`), or null when
 * nothing in it is statable right now. Bounded cost: each directory is probed with exactly one
 * `readdir` plus one `stat` per direct entry -- never a recursive walk of the whole worktree, and
 * never more than the entry count of the explicit, documented watched set. Never throws -- a
 * missing/unreadable path (worktree not yet created, output dir not yet made, a `statFn`/
 * `readdirFn` that rejects or even throws synchronously) degrades to "no evidence from that
 * path", not a crash, so this can never itself hang or take down the phase it's watching.
 */
export async function probeLivenessMtime({
  worktreeDir,
  runLogPath,
  outputSubpaths = DEFAULT_PRESERVED_ARTIFACT_PATHS,
  statFn = fs.stat,
  readdirFn = fs.readdir
}) {
  const { dirs, files } = watchedLivenessPaths({ worktreeDir, runLogPath, outputSubpaths });
  let freshest = null;
  for (const dir of dirs) {
    let observed;
    try {
      observed = await freshestEntryMtime({ dir, statFn, readdirFn });
    } catch {
      observed = null;
    }
    if (observed && (!freshest || observed.mtimeMs > freshest.mtimeMs)) freshest = observed;
  }
  for (const file of files) {
    try {
      const stat = await statFn(file);
      if (!freshest || stat.mtimeMs > freshest.mtimeMs) freshest = { path: file, mtimeMs: stat.mtimeMs };
    } catch {
      // missing/unreadable/threw -- skip, degrade to no evidence from this one path
    }
  }
  return freshest;
}
