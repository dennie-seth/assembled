import { spawn as nodeSpawn } from "node:child_process";
import { rateLimitInfoFromEvent } from "./usageLimitDetector.js";

/**
 * T-0438: the real decision-time probe `usageTelemetry.js`'s `withFreshProbe` calls when the
 * log-scan reading for `five_hour` is not already fresh. A minimal, throwaway `claude` CLI
 * invocation whose only purpose is to force one fresh `rate_limit_event` right now, independent
 * of whether any real card run has happened recently enough to have refreshed the log-scan
 * reading on its own.
 *
 * Cost, stated from evidence, not assumed: `tasks/.runs/T-0438-*.jsonl` (this card's own run log)
 * shows the `rate_limit_event` arriving at line 1, BEFORE the first `assistant` turn's own
 * cache-creation cost (33,544 `cache_creation_input_tokens` at line 4) -- the CLI reports this
 * reading as part of its own preflight, before it spends on the turn itself. `spawnUsageProbe`
 * kills the child the instant it sees that event, so its cost is bounded to whatever that
 * preflight exchange alone costs -- there is no card body, no tool list, no system prompt on this
 * invocation (`buildProbeArgs` carries neither `--allowedTools` nor `--settings`), unlike a real
 * card run. It is charged against the same five-hour window it measures (see docs/usage-telemetry.md
 * for the per-day bound this implies at the live board's `AUTO_LAUNCH_INTERVAL_MS` cadence).
 *
 * Wired in as the default once auto-launch itself is running: `createAutoLaunchPoller`'s own
 * `usageProbeFn` constructor option defaults to this function unless `USAGE_PROBE_DISABLED` is
 * set (see autoLaunchPoller.js's `usageProbeDisabledFromEnv`). The actual "deploying the code
 * must not start spending" gate is `AUTO_LAUNCH_ENABLED` -- `usageProbeFn` is never consulted
 * unless a human already opted into that -- so this does not need its own separate default-off
 * switch on top; see autoLaunchPoller.js's docstring for why a second opt-in would just reproduce
 * this card's own bug. Tested throughout via an injected `spawnFn`, never a live `claude`
 * invocation -- the same pattern `claudeCliRunner.js`'s own test suite already uses for exactly
 * this reason: no persona in this runner holds a grant to invoke `claude` directly to verify a
 * live spawn.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_PROBE_KILL_ESCALATION_MS = 3_000;

/** No `--allowedTools`, no `--settings`, no model flag -- the smallest invocation that still runs. */
export function buildProbeArgs() {
  return ["-p", "--output-format", "stream-json", "--verbose"];
}

function killProbeChild(child, escalationMs, setTimeoutFn, clearTimeoutFn) {
  if (!child || typeof child.kill !== "function") return;
  const pid = typeof child.pid === "number" ? child.pid : null;
  const sendSignal = (signal) => {
    if (pid !== null) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Not a process group leader (or already dead) -- fall back below.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // Already dead -- nothing left to signal.
    }
  };
  sendSignal("SIGTERM");
  const escalationTimer = setTimeoutFn(() => sendSignal("SIGKILL"), escalationMs);
  if (typeof escalationTimer.unref === "function") escalationTimer.unref();
  if (typeof child.once === "function") {
    child.once("exit", () => clearTimeoutFn(escalationTimer));
  }
}

/**
 * Spawns `command` with `buildProbeArgs()`, resolves `{ rateLimitInfo }` the instant a
 * `rate_limit_event` line arrives on stdout, and kills the child immediately after -- never lets
 * it reach an actual assistant turn. Resolves `null` (never rejects) on spawn failure, a timeout,
 * or the child exiting without ever emitting a usable event -- fail-safe, same contract every
 * other reader in `usageTelemetry.js` already has: "could not get a fresh reading" is `null`,
 * never a guess.
 */
export async function spawnUsageProbe({
  spawnFn = nodeSpawn,
  command = "claude",
  env = process.env,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  killEscalationMs = DEFAULT_PROBE_KILL_ESCALATION_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let child = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timer);
      if (child) killProbeChild(child, killEscalationMs, setTimeoutFn, clearTimeoutFn);
      resolve(result);
    };

    const timer = setTimeoutFn(() => finish(null), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    try {
      child = spawnFn(command, buildProbeArgs(), { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      finish(null);
      return;
    }

    child.on("error", () => finish(null));
    // "close" fires only after stdio has fully flushed; "exit" can fire first, while a
    // rate_limit_event line is still buffered on stdout -- finishing on "exit" would discard a
    // reading that was already on its way (see usageProbe.test.js's exit-vs-close case).
    child.on("close", () => finish(null));

    let buffer = "";
    child.stdout?.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim().length === 0) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const info = rateLimitInfoFromEvent(event);
        if (info) {
          finish({ rateLimitInfo: info });
          return;
        }
      }
    });
    child.stderr?.on("data", () => {});

    if (child.stdin) {
      // Never meant to be read as a real turn -- this probe exists only to elicit the CLI's own
      // preflight rate_limit_event, not to have the model respond to anything.
      child.stdin.on("error", () => {});
      child.stdin.write(".");
      child.stdin.end();
    }
  });
}

/**
 * The `probeFn` shape `usageTelemetry.js`'s `readWindowUsage` calls: `({windowKind, now}) =>
 * Promise<{rateLimitInfo}|null>`. Refuses anything other than `five_hour` on its own, in addition
 * to (never instead of) `usageTelemetry.js`'s own `PROBEABLE_WINDOW_KINDS` guard -- belt and
 * suspenders, so this function is safe to pass as a blanket probe even if some future caller
 * forgets that guard exists.
 */
export async function defaultUsageProbeFn({ windowKind } = {}) {
  if (windowKind !== "five_hour") return null;
  return spawnUsageProbe();
}
