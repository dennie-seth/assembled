import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

const DEFAULT_RECENT_MS = 2 * 60 * 1000;

/**
 * True when `pgrep -af claude` finds a process that looks like the board's own headless
 * agent invocation (`claude -p --output-format stream-json ...`, see
 * `ClaudeCliRunner.buildInvocation`) rather than some unrelated process that merely has
 * "claude" somewhere in its command line (an editor, a shell history search, this very
 * check running under a differently-named wrapper, ...). `pgrep` exits 1 when nothing
 * matches at all -- not an error, just "no candidates" -- so that's treated as `false`
 * rather than thrown.
 */
export async function hasLiveClaudeProcess({ execFn = execFileAsync } = {}) {
  let stdout = "";
  try {
    ({ stdout } = await execFn("pgrep", ["-af", "claude"]));
  } catch (err) {
    if (err && err.code === 1) return false;
    throw new Error(`pgrep -af claude failed: ${(err && (err.stderr || err.message)) || err}`);
  }
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => /\bclaude\b.*\s-p\b/.test(line) || /\bclaude\b.*\s--print\b/.test(line));
}

/**
 * True when any `tasks/.runs/*.jsonl` file was modified within `recentMs` of `now()`. A
 * run's log (see `runLog.js`) is appended to continuously while the agent works and never
 * gets an explicit "closed" marker written into it, so a recent mtime is the cheapest
 * available signal that a run is still actively writing rather than a stale leftover from
 * a run that already finished. A missing `tasks/.runs` directory (nothing has ever run
 * yet) is treated as `false`, not an error.
 */
export async function hasRecentlyGrowingRunLog({
  runsDir,
  recentMs = DEFAULT_RECENT_MS,
  now = () => Date.now(),
  readdirFn = fs.readdir,
  statFn = fs.stat
} = {}) {
  let entries;
  try {
    entries = await readdirFn(runsDir);
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }

  const nowMs = now();
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const stat = await statFn(path.join(runsDir, name));
    if (nowMs - stat.mtimeMs <= recentMs) {
      return true;
    }
  }
  return false;
}

/**
 * The deploy-time safety gate: a card run is considered "live" (unsafe to deploy over) if
 * *either* signal says so. Two independent signals because either one alone can miss a
 * live run -- pgrep misses a run wrapped/renamed in a way that doesn't match "claude -p" on
 * the command line, mtime misses the narrow window between a run's process exiting and its
 * log's last write. They're OR'd together deliberately: a false "safe to deploy" here is
 * what caused the mid-merge `node --watch` outage this guard exists to prevent (a reset
 * live card, then a crash on a conflict-markered file, 20+ minutes down); a false "not
 * safe" just costs a retried deploy a little later.
 */
export async function detectLiveRun({ runsDir, execFn, readdirFn, statFn, now, recentMs } = {}) {
  const [processLive, logGrowing] = await Promise.all([
    hasLiveClaudeProcess({ execFn }),
    hasRecentlyGrowingRunLog({ runsDir, recentMs, now, readdirFn, statFn })
  ]);
  return {
    live: processLive || logGrowing,
    processLive,
    logGrowing
  };
}
