import { spawn as nodeSpawn } from "node:child_process";
import { AgentRunner } from "./agentRunner.js";

export const DEFAULT_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TZ"];

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
    const resolvedModel = model ?? this.model;
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

  kill(run) {
    const child = run && run.child ? run.child : run;
    if (!child || typeof child.kill !== "function") {
      return;
    }
    if (typeof child.pid === "number") {
      try {
        process.kill(-child.pid, "SIGTERM");
        return;
      } catch {
        // Not a process group leader (or already dead) -- fall back below.
      }
    }
    child.kill();
  }
}
