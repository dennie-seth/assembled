import { spawn } from "node:child_process";

const AUTO_RESTART_DISABLE_VALUES = new Set(["0", "false", "off", "no"]);
const SERVICE_NAME = "assembled-board.service";

/** AUTO_RESTART_ON_PULL env var: default ON; set to "0"/"false"/"off"/"no" (any case) to disable restart-on-pull. */
export function autoRestartOnPullFromEnv() {
  return !AUTO_RESTART_DISABLE_VALUES.has((process.env.AUTO_RESTART_ON_PULL ?? "").toLowerCase());
}

/**
 * Restarts the board's systemd user unit, detached from this process. The card
 * runner (`claude -p`) is a child of this same unit, so a naive restart from
 * inside a request handler would tear itself down along with any in-flight run.
 * `detached: true` puts the spawned `systemctl` invocation in its own session
 * (Node calls setsid() under the hood on POSIX, same effect as prefixing the
 * command with the `setsid` binary) so it outlives the SIGTERM the dying unit
 * sends us and keeps running once we're gone. `stdio: "ignore"` + `unref()`
 * mean nothing about this process holds the event loop open waiting on it.
 */
export function restartBoardService({ spawnFn = spawn } = {}) {
  const child = spawnFn("systemctl", ["--user", "restart", SERVICE_NAME], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return child;
}

/**
 * Coordinates restart-on-pull so a restart never lands mid-run (that exact
 * failure mode cost the T-0111 run). `notifyPulled` fires right after a pull
 * that actually advanced HEAD; if a card run is active it just remembers to
 * restart later instead of acting immediately. `notifyIdle` fires whenever
 * the orchestrator has no active runs left -- if a restart is pending, this
 * is where the deferred restart actually happens.
 */
export function createRestartCoordinator({
  restart = restartBoardService,
  enabled = autoRestartOnPullFromEnv(),
  logger = console
} = {}) {
  let pending = false;

  function triggerRestart(reason) {
    pending = false;
    logger.log(`assembled-board: ${reason} -- restarting service to pick up pulled code`);
    restart();
  }

  return {
    notifyPulled({ hasActiveRuns }) {
      if (!enabled) return;
      if (hasActiveRuns) {
        pending = true;
        logger.log("assembled-board: develop pulled while a card run is active -- restart deferred until idle");
        return;
      }
      triggerRestart("develop pulled, no active runs");
    },
    notifyIdle() {
      if (!enabled || !pending) return;
      triggerRestart("deferred restart: active run finished");
    },
    get pending() {
      return pending;
    },
    get enabled() {
      return enabled;
    }
  };
}
