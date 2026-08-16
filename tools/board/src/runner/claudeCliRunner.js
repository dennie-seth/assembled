import { spawn as nodeSpawn } from "node:child_process";
import { AgentRunner } from "./agentRunner.js";
import { DEFAULT_KILL_ESCALATION_MS } from "./runState.js";

export const DEFAULT_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TZ"];

/**
 * Validates a `--model` value before it reaches argv. Accepts Claude Code's
 * short aliases (sonnet/opus/haiku/fable) and full model strings (e.g.
 * "claude-sonnet-5", "claude-opus-4-1-20250805", or a Bedrock-style
 * "us.anthropic.claude-3-5-sonnet-...:0" id) -- deliberately not an
 * exhaustive allowlist, since new model names ship independently of this
 * repo. Rejects non-strings (malformed frontmatter, e.g. a YAML mapping),
 * blank/whitespace-only values, embedded whitespace, and anything starting
 * with "-" (which argv would otherwise parse as a CLI flag). Returns
 * `undefined` unchanged so "no model configured" stays silent.
 */
function validateModel(model) {
  if (model === undefined || model === null) {
    return undefined;
  }
  if (typeof model !== "string") {
    throw new Error(`ClaudeCliRunner: model must be a string, got ${JSON.stringify(model)}`);
  }
  const trimmed = model.trim();
  if (trimmed.length === 0) {
    throw new Error("ClaudeCliRunner: model must not be blank");
  }
  if (/\s/.test(trimmed)) {
    throw new Error(`ClaudeCliRunner: model "${trimmed}" must not contain whitespace`);
  }
  if (trimmed.startsWith("-")) {
    throw new Error(`ClaudeCliRunner: model "${trimmed}" looks like a CLI flag, not a model name`);
  }
  return trimmed;
}

/**
 * Spawns the headless Claude CLI (`claude -p --output-format stream-json`)
 * per card run. Argv construction and env isolation are pure (buildInvocation);
 * start()/kill() are the only methods that touch the injected spawnFn.
 */
export class ClaudeCliRunner extends AgentRunner {
  constructor({
    spawnFn = nodeSpawn,
    command = "claude",
    envAllowlist = DEFAULT_ENV_ALLOWLIST,
    extraEnv = {},
    model,
    hostEnv = process.env
  } = {}) {
    super();
    this.spawnFn = spawnFn;
    this.command = command;
    this.envAllowlist = envAllowlist;
    this.extraEnv = extraEnv;
    this.model = model;
    this.hostEnv = hostEnv;
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

  buildInvocation({ task, prompt, allowedTools, worktreeDir, model }) {
    if (!task || typeof task.id !== "string" || task.id.length === 0) {
      throw new Error("ClaudeCliRunner requires a task with an id");
    }
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new Error("ClaudeCliRunner requires a non-empty prompt");
    }
    if (!Array.isArray(allowedTools)) {
      throw new Error("ClaudeCliRunner requires allowedTools to be an array");
    }
    if (typeof worktreeDir !== "string" || worktreeDir.length === 0) {
      throw new Error("ClaudeCliRunner requires a worktreeDir to isolate the run");
    }

    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      allowedTools.join(" ")
    ];
    const resolvedModel = validateModel(model ?? this.model);
    if (resolvedModel) {
      args.push("--model", resolvedModel);
    }
    args.push(prompt);

    return {
      command: this.command,
      args,
      cwd: worktreeDir,
      env: this.buildEnv()
    };
  }

  async start({ task, prompt, allowedTools, worktreeDir, model }) {
    const invocation = this.buildInvocation({ task, prompt, allowedTools, worktreeDir, model });
    const child = this.spawnFn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      // Detached so kill() can target the whole process group (-pid), not just this
      // one process -- a headless `claude -p` run may spawn its own Bash-tool
      // children, and a plain child.kill() would leave those orphaned on cancel.
      detached: true,
      // stdin MUST NOT be left as an open, unwritten pipe: the prompt is already
      // passed as an argv element, but the real CLI still probes stdin at
      // startup, and Node's default 'pipe' stdio leaves that fd open with
      // nothing ever written or closed -- the child blocks reading it forever.
      // 'ignore' gives it immediate EOF (verified against the real CLI), which
      // it treats the same as "no stdin input, use the prompt argument".
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { runId: task.id, child, invocation };
  }

  observe(run) {
    return run.child;
  }

  /**
   * Sends SIGTERM to the child's whole process group (so a grandchild it spawned via its own
   * Bash tool -- e.g. a hung `godot --headless` test -- dies too, not just the `claude` process
   * itself), then escalates to SIGKILL after `escalationMs` if the child is still alive by then.
   * The escalation matters: a subprocess that traps/ignores SIGTERM (or is stuck in an
   * uninterruptible read) would otherwise wedge forever even after a "kill". Cancelled
   * automatically if the child's own `exit` event fires first.
   */
  kill(run, { escalationMs = DEFAULT_KILL_ESCALATION_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
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
