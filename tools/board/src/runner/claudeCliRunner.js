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

  buildInvocation({ task, prompt, allowedTools, worktreeDir }) {
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
    if (this.model) {
      args.push("--model", this.model);
    }
    args.push(prompt);

    return {
      command: this.command,
      args,
      cwd: worktreeDir,
      env: this.buildEnv()
    };
  }

  async start({ task, prompt, allowedTools, worktreeDir }) {
    const invocation = this.buildInvocation({ task, prompt, allowedTools, worktreeDir });
    const child = this.spawnFn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env
    });
    return { runId: task.id, child, invocation };
  }

  observe(run) {
    return run.child;
  }

  kill(run) {
    const child = run && run.child ? run.child : run;
    if (child && typeof child.kill === "function") {
      child.kill();
    }
  }
}
