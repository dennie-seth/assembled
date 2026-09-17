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
 *
 * `pgrep -af claude` is system-wide: it also matches `claude` processes that have nothing
 * to do with this board (a manual repro shell, another project's agent session, ...) but
 * happen to be invoked with `-p`/`--print` too, which trips this guard as a false positive
 * and blocks deploy for no reason (see the T-0210 deploy incident this was hardened after).
 * When `boardDirs` is given, a matching pid is only counted if its cwd (`/proc/<pid>/cwd`)
 * is the board's repo root or a worktree under it -- where `ClaudeCliRunner` always launches
 * card-run processes from. A pid whose cwd can't be read (already exited, owned by another
 * user -- board runs are always this user) is dropped rather than counted, since it can't be
 * confirmed as a board run either way. Omitting `boardDirs` keeps the old unscoped behavior.
 */
export async function hasLiveClaudeProcess({ execFn = execFileAsync, boardDirs, readlinkFn = fs.readlink } = {}) {
  let stdout = "";
  try {
    ({ stdout } = await execFn("pgrep", ["-af", "claude"]));
  } catch (err) {
    if (err && err.code === 1) return false;
    throw new Error(`pgrep -af claude failed: ${(err && (err.stderr || err.message)) || err}`);
  }

  const candidates = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /\bclaude\b.*\s-p\b/.test(line) || /\bclaude\b.*\s--print\b/.test(line));

  if (candidates.length === 0) return false;
  if (!boardDirs || boardDirs.length === 0) return true;

  for (const line of candidates) {
    const [pid] = line.split(/\s+/);
    let cwd;
    try {
      cwd = await readlinkFn(`/proc/${pid}/cwd`);
    } catch {
      continue;
    }
    if (boardDirs.some((dir) => cwd === dir || cwd.startsWith(`${dir}/`))) {
      return true;
    }
  }
  return false;
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
export async function detectLiveRun({ runsDir, execFn, readdirFn, statFn, now, recentMs, boardDirs, readlinkFn } = {}) {
  const [processLive, logGrowing] = await Promise.all([
    hasLiveClaudeProcess({ execFn, boardDirs, readlinkFn }),
    hasRecentlyGrowingRunLog({ runsDir, recentMs, now, readdirFn, statFn })
  ]);
  return {
    live: processLive || logGrowing,
    processLive,
    logGrowing
  };
}
