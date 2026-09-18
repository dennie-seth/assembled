import { spawn } from "node:child_process";
import chokidar from "chokidar";
import { detectLiveRun } from "../runner/liveRunGuard.js";

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_POLL_INTERVAL_MS = 2000;

/**
 * Replaces `node --watch` for the board's own dev/deploy process (`dev:server`). `node --watch`
 * restarts on any changed file unconditionally, which is what bypassed serviceRestart.js's
 * active-run guard and dropped the API listener mid-run in the #394/#395 incident (T-0385): the
 * guard had already logged "restart deferred until idle", but `--watch` tore the process down
 * anyway. This applies the exact same `detectLiveRun` signal `npm run deploy`'s live-run check
 * already uses -- pgrep for a live `claude -p` run plus a recently-growing `tasks/.runs/*.jsonl`
 * -- before ever restarting the watched child, deferring and re-checking on a short poll until
 * the run guard reports idle, then restarting with no further file change needed.
 */
export function createWatchSupervisor({
  entryPath,
  watchPaths,
  runsDir,
  boardDirs,
  spawnFn = spawn,
  watchFn = (paths) => chokidar.watch(paths, { ignoreInitial: true }),
  detectLiveRunFn = detectLiveRun,
  logger = console,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
} = {}) {
  let child = null;
  let watcher = null;
  let debounceTimer = null;
  let pollTimer = null;
  let restarting = false;
  let stopped = false;

  function spawnChild() {
    child = spawnFn(process.execPath, [entryPath], { stdio: "inherit" });
  }

  function killChild() {
    return new Promise((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      try {
        child.kill("SIGTERM");
      } catch {
        resolve();
      }
    });
  }

  function clearPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function performRestart(reason) {
    if (restarting || stopped) return;
    restarting = true;
    try {
      logger.log(`assembled-board: ${reason} -- restarting watched process`);
      await killChild();
      if (!stopped) spawnChild();
    } finally {
      restarting = false;
    }
  }

  async function evaluate() {
    if (stopped) return;
    const { live } = await detectLiveRunFn({ runsDir, boardDirs });
    if (!live) {
      const wasDeferred = Boolean(pollTimer);
      clearPoll();
      await performRestart(wasDeferred ? "deferred restart: active run finished" : "file change detected, no active runs");
      return;
    }
    if (!pollTimer) {
      logger.log("assembled-board: file change detected while a card run is active -- restart deferred until idle");
      pollTimer = setInterval(() => {
        evaluate().catch((err) => logger.error(`assembled-board: watch guard poll failed: ${err.message}`));
      }, pollIntervalMs);
      if (typeof pollTimer.unref === "function") pollTimer.unref();
    }
  }

  function scheduleEvaluate() {
    // Already deferred and actively re-checking on the poll -- no need to re-debounce on top.
    if (pollTimer) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      evaluate().catch((err) => logger.error(`assembled-board: watch guard evaluation failed: ${err.message}`));
    }, debounceMs);
    if (typeof debounceTimer.unref === "function") debounceTimer.unref();
  }

  function start() {
    spawnChild();
    watcher = watchFn(watchPaths);
    watcher.on("all", () => scheduleEvaluate());
    return { child };
  }

  async function stop() {
    stopped = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    clearPoll();
    if (watcher) await watcher.close();
    await killChild();
  }

  return {
    start,
    stop,
    get child() {
      return child;
    }
  };
}
