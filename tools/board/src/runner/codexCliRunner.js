import { spawn as nodeSpawn } from "node:child_process";
import { AgentRunner } from "./agentRunner.js";
import { DEFAULT_KILL_ESCALATION_MS } from "./runState.js";

/**
 * T-0460: env vars the spawned `codex exec` child actually needs, and nothing else.
 * - PATH: codex spawns its own command-execution subprocesses (bash/powershell) for tool calls.
 * - HOME/TZ/LANG/LC_ALL/TERM: ordinary process locale/terminal plumbing, not Codex-specific.
 * - CODEX_HOME: points at the on-disk auth/config directory (`auth.json`, `config.toml`) this
 *   adapter authenticates against. Explicit rather than inherited so a reviewer run never falls
 *   back to some other identity's default `~/.codex` by accident.
 * Deliberately excludes anything else from the host environment -- see
 * docs/design/codex-reviewer-adapter-spike.md's least-privilege section for the enumerated
 * grant/reason list this allowlist is the code-level half of.
 */
export const DEFAULT_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TZ", "CODEX_HOME"];

/** Wall-clock ceiling for one review turn if the caller doesn't override it (10 minutes). */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Spawns `codex exec` read-only and non-interactively per review. Mirrors ClaudeCliRunner's
 * shape (buildInvocation is pure; start()/kill() are the only methods touching spawnFn) so this
 * is a second AgentRunner sibling, not a parallel coordinator -- see agentRunner.js.
 *
 * The sandbox mode is NOT a constructor or call option on purpose (T-0460 acceptance: "it cannot
 * widen its own scope"). This class reviews read-only, full stop; a caller cannot hand it
 * `workspace-write` or `danger-full-access` through any input, including the prompt text, which
 * travels over stdin and is never parsed as argv.
 */
export class CodexCliRunner extends AgentRunner {
  constructor({
    spawnFn = nodeSpawn,
    command = "codex",
    envAllowlist = DEFAULT_ENV_ALLOWLIST,
    extraEnv = {},
    hostEnv = process.env,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  } = {}) {
    super();
    this.spawnFn = spawnFn;
    this.command = command;
    this.envAllowlist = envAllowlist;
    this.extraEnv = extraEnv;
    this.hostEnv = hostEnv;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
  }

  buildEnv() {
    const env = {};
    for (const key of this.envAllowlist) {
      if (this.hostEnv[key] !== undefined) {
        env[key] = this.hostEnv[key];
      }
    }
    return { ...env, ...this.extraEnv };
  }

  buildInvocation({ task, prompt, worktreeDir, boardRunId, outputSchemaPath }) {
    if (!task || typeof task.id !== "string" || task.id.length === 0) {
      throw new Error("CodexCliRunner requires a task with an id");
    }
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new Error("CodexCliRunner requires a non-empty prompt");
    }
    if (typeof worktreeDir !== "string" || worktreeDir.length === 0) {
      throw new Error("CodexCliRunner requires a worktreeDir to isolate the run");
    }

    // Fixed argv, built entirely from code -- never from the prompt, task body, or any model
    // output (there is no model output yet at this point; this is what configures the process
    // that will produce it). `-s read-only` and `--skip-git-repo-check` are hardcoded, not
    // threaded from any caller-supplied option, which is what makes "never widens its own scope"
    // true of this method rather than just asserted of it.
    const args = ["exec", "--json", "-s", "read-only", "--skip-git-repo-check", "-C", worktreeDir];
    if (typeof outputSchemaPath === "string" && outputSchemaPath.length > 0) {
      args.push("--output-schema", outputSchemaPath);
    }

    // Same E2BIG concern ClaudeCliRunner's docstring documents (T-0291/T-0243): the prompt
    // travels over stdin (see start()), never as an argv element, so its size never interacts
    // with the OS's per-argument length ceiling.
    const env = this.buildEnv();
    if (typeof boardRunId === "string" && boardRunId.length > 0) {
      env.BOARD_RUN_ID = boardRunId;
    }

    return { command: this.command, args, cwd: worktreeDir, env, prompt };
  }

  async start({ task, prompt, worktreeDir, boardRunId, outputSchemaPath, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const invocation = this.buildInvocation({ task, prompt, worktreeDir, boardRunId, outputSchemaPath });
    let child;
    try {
      child = this.spawnFn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        // Detached so kill() can target the whole process group -- codex itself spawns
        // command-execution children for tool calls, and a plain child.kill() would orphan them.
        detached: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (err) {
      return { runId: task.id, child: null, invocation, spawnError: err, timedOut: false };
    }

    const run = { runId: task.id, child, invocation, spawnError: null, timedOut: false };

    child.on("error", (err) => {
      run.spawnError = err;
    });
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.write(invocation.prompt);
      child.stdin.end();
    }

    // Bounded runtime (T-0460 acceptance: "the one real review is bounded in runtime ... and
    // both bounds are enforced"). A review that never exits -- a hang, a stuck tool call -- gets
    // killed rather than left running indefinitely; see codexVerdictPublisher.js for the
    // corresponding BLOCKED-on-timeout outcome this produces.
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      const timer = this.setTimeoutFn(() => {
        run.timedOut = true;
        this.kill(run);
      }, timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      if (typeof child.once === "function") {
        child.once("exit", () => this.clearTimeoutFn(timer));
      }
    }

    return run;
  }

  observe(run) {
    return run.child;
  }

  /** Identical process-group SIGTERM/SIGKILL escalation to ClaudeCliRunner.kill -- see its docstring. */
  kill(run, { escalationMs = DEFAULT_KILL_ESCALATION_MS, setTimeoutFn = this.setTimeoutFn, clearTimeoutFn = this.clearTimeoutFn } = {}) {
    const child = run && run.child ? run.child : run;
    if (!child || typeof child.kill !== "function") {
      return;
    }

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
    if (typeof escalationTimer.unref === "function") {
      escalationTimer.unref();
    }
    if (typeof child.once === "function") {
      child.once("exit", () => clearTimeoutFn(escalationTimer));
    }
  }
}
