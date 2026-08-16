import { describe, it, expect, vi } from "vitest";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { AgentRunner } from "../../src/runner/agentRunner.js";
import { ClaudeCliRunner } from "../../src/runner/claudeCliRunner.js";
import { DEFAULT_KILL_ESCALATION_MS } from "../../src/runner/runState.js";

const TASK = { id: "T-0099", agent: "infra" };

function fakeChild() {
  return { stdout: {}, stderr: {}, kill: vi.fn(), on: vi.fn() };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("ClaudeCliRunner argv construction", () => {
  it("is an AgentRunner", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    expect(runner).toBeInstanceOf(AgentRunner);
  });

  it("constructs the exact argv for a task run", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    const invocation = runner.buildInvocation({
      task: TASK,
      prompt: "do the thing",
      allowedTools: ["Read", "Write", "Bash(git:*)"],
      worktreeDir: "/repo/worktrees/T-0099"
    });

    expect(invocation.command).toBe("claude");
    expect(invocation.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      "Read Write Bash(git:*)",
      "do the thing"
    ]);
    expect(invocation.cwd).toBe("/repo/worktrees/T-0099");
  });

  it("includes --model when a model is configured, omits it otherwise", () => {
    const withModel = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {}, model: "sonnet" });
    const invocation = withModel.buildInvocation({
      task: TASK,
      prompt: "x",
      allowedTools: ["Read"],
      worktreeDir: "/wt"
    });
    expect(invocation.args).toContain("--model");
    expect(invocation.args[invocation.args.indexOf("--model") + 1]).toBe("sonnet");

    const withoutModel = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    const invocation2 = withoutModel.buildInvocation({
      task: TASK,
      prompt: "x",
      allowedTools: ["Read"],
      worktreeDir: "/wt"
    });
    expect(invocation2.args).not.toContain("--model");
  });

  it("accepts a per-call model override that takes precedence over the constructor's model", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {}, model: "sonnet" });
    const invocation = runner.buildInvocation({
      task: TASK,
      prompt: "x",
      allowedTools: ["Read"],
      worktreeDir: "/wt",
      model: "opus"
    });
    expect(invocation.args[invocation.args.indexOf("--model") + 1]).toBe("opus");
  });

  it("falls back to the constructor's model when no per-call model is given", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {}, model: "sonnet" });
    const invocation = runner.buildInvocation({
      task: TASK,
      prompt: "x",
      allowedTools: ["Read"],
      worktreeDir: "/wt"
    });
    expect(invocation.args[invocation.args.indexOf("--model") + 1]).toBe("sonnet");
  });

  it("accepts Claude Code model aliases and full model strings", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    for (const model of [
      "sonnet",
      "opus",
      "haiku",
      "fable",
      "claude-sonnet-5",
      "claude-opus-4-1-20250805",
      "us.anthropic.claude-3-5-sonnet-20241022-v2:0"
    ]) {
      const invocation = runner.buildInvocation({
        task: TASK,
        prompt: "x",
        allowedTools: ["Read"],
        worktreeDir: "/wt",
        model
      });
      expect(invocation.args[invocation.args.indexOf("--model") + 1]).toBe(model);
    }
  });

  it("trims incidental whitespace around an otherwise-valid model value", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    const invocation = runner.buildInvocation({
      task: TASK,
      prompt: "x",
      allowedTools: ["Read"],
      worktreeDir: "/wt",
      model: "  opus  "
    });
    expect(invocation.args[invocation.args.indexOf("--model") + 1]).toBe("opus");
  });

  it("rejects a whitespace-only model instead of silently omitting --model", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    expect(() =>
      runner.buildInvocation({ task: TASK, prompt: "x", allowedTools: ["Read"], worktreeDir: "/wt", model: "   " })
    ).toThrow(/model/i);
  });

  it("rejects a non-string model (malformed frontmatter, e.g. a YAML mapping)", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    for (const badModel of [{ foo: "bar" }, ["opus"], 42, true]) {
      expect(() =>
        runner.buildInvocation({
          task: TASK,
          prompt: "x",
          allowedTools: ["Read"],
          worktreeDir: "/wt",
          model: badModel
        })
      ).toThrow(/model/i);
    }
  });

  it("rejects a model value containing internal whitespace or newlines", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    for (const badModel of ["opus sonnet", "claude\nopus", "claude\topus"]) {
      expect(() =>
        runner.buildInvocation({ task: TASK, prompt: "x", allowedTools: ["Read"], worktreeDir: "/wt", model: badModel })
      ).toThrow(/model/i);
    }
  });

  it("rejects a model value that looks like a CLI flag", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    expect(() =>
      runner.buildInvocation({
        task: TASK,
        prompt: "x",
        allowedTools: ["Read"],
        worktreeDir: "/wt",
        model: "--dangerously-skip-permissions"
      })
    ).toThrow(/model/i);
  });

  it("never includes a dangerous-skip-permissions flag", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    const invocation = runner.buildInvocation({
      task: TASK,
      prompt: "x",
      allowedTools: ["Read"],
      worktreeDir: "/wt"
    });
    expect(invocation.args.some((a) => a.toLowerCase().includes("dangerously-skip-permissions"))).toBe(
      false
    );
  });

  it("passes the prompt as the trailing argv element", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    const invocation = runner.buildInvocation({
      task: TASK,
      prompt: "the exact prompt text",
      allowedTools: ["Read"],
      worktreeDir: "/wt"
    });
    expect(invocation.args[invocation.args.length - 1]).toBe("the exact prompt text");
  });

  it("rejects a missing or empty prompt", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    expect(() =>
      runner.buildInvocation({ task: TASK, prompt: "", allowedTools: ["Read"], worktreeDir: "/wt" })
    ).toThrow();
    expect(() =>
      runner.buildInvocation({ task: TASK, allowedTools: ["Read"], worktreeDir: "/wt" })
    ).toThrow();
  });

  it("requires a worktreeDir to isolate the run as the child cwd", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    expect(() =>
      runner.buildInvocation({ task: TASK, prompt: "x", allowedTools: ["Read"] })
    ).toThrow();
  });

  it("requires allowedTools to be an array", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    expect(() =>
      runner.buildInvocation({ task: TASK, prompt: "x", worktreeDir: "/wt" })
    ).toThrow();
  });

  it("requires a task with an id", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    expect(() =>
      runner.buildInvocation({ prompt: "x", allowedTools: ["Read"], worktreeDir: "/wt" })
    ).toThrow();
  });
});

describe("ClaudeCliRunner env isolation", () => {
  it("drops arbitrary host env vars, keeping only the explicit allowlist", () => {
    const hostEnv = {
      PATH: "/usr/bin",
      HOME: "/home/dennieseth",
      SECRET_TOKEN: "shh",
      RANDOM_LEAKY_VAR: "leak-me"
    };
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv });
    const invocation = runner.buildInvocation({
      task: TASK,
      prompt: "x",
      allowedTools: ["Read"],
      worktreeDir: "/wt"
    });
    expect(invocation.env.PATH).toBe("/usr/bin");
    expect(invocation.env.HOME).toBe("/home/dennieseth");
    expect(invocation.env.SECRET_TOKEN).toBeUndefined();
    expect(invocation.env.RANDOM_LEAKY_VAR).toBeUndefined();
  });

  it("respects a custom envAllowlist", () => {
    const hostEnv = { PATH: "/usr/bin", CUSTOM_VAR: "keep-me", HOME: "/home/x" };
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv, envAllowlist: ["PATH", "CUSTOM_VAR"] });
    const invocation = runner.buildInvocation({
      task: TASK,
      prompt: "x",
      allowedTools: ["Read"],
      worktreeDir: "/wt"
    });
    expect(invocation.env.CUSTOM_VAR).toBe("keep-me");
    expect(invocation.env.HOME).toBeUndefined();
  });

  it("merges explicit extraEnv on top of the allowlisted host env", () => {
    const runner = new ClaudeCliRunner({
      spawnFn: vi.fn(),
      hostEnv: { PATH: "/usr/bin" },
      extraEnv: { CLAUDE_CONFIG_DIR: "/wt/.claude-config" }
    });
    const invocation = runner.buildInvocation({
      task: TASK,
      prompt: "x",
      allowedTools: ["Read"],
      worktreeDir: "/wt"
    });
    expect(invocation.env.CLAUDE_CONFIG_DIR).toBe("/wt/.claude-config");
    expect(invocation.env.PATH).toBe("/usr/bin");
  });

  it("does not leak the whole process.env by default when hostEnv is not overridden", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn() });
    const invocation = runner.buildInvocation({
      task: TASK,
      prompt: "x",
      allowedTools: ["Read"],
      worktreeDir: "/wt"
    });
    expect(Object.keys(invocation.env).every((k) => runner.envAllowlist.includes(k))).toBe(true);
  });
});

describe("ClaudeCliRunner.start / kill", () => {
  it("start() invokes spawnFn with the built command/args/options and returns a run handle", async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const runner = new ClaudeCliRunner({ spawnFn, hostEnv: { PATH: "/usr/bin" } });

    const run = await runner.start({
      task: TASK,
      prompt: "do the thing",
      allowedTools: ["Read"],
      worktreeDir: "/wt"
    });

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnFn.mock.calls[0];
    expect(command).toBe("claude");
    expect(args[args.length - 1]).toBe("do the thing");
    expect(options.cwd).toBe("/wt");
    expect(options.env.PATH).toBe("/usr/bin");
    expect(run.child).toBe(child);
    expect(run.runId).toBe(TASK.id);
  });

  it("kill() terminates the underlying child process", async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const runner = new ClaudeCliRunner({ spawnFn, hostEnv: {} });
    const run = await runner.start({
      task: TASK,
      prompt: "x",
      allowedTools: ["Read"],
      worktreeDir: "/wt"
    });

    runner.kill(run);

    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("kill() is a no-op when given a handle with no child process", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    expect(() => runner.kill({})).not.toThrow();
    expect(() => runner.kill(null)).not.toThrow();
  });

  it("start() spawns the child detached so its process group can be killed as a unit", async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const runner = new ClaudeCliRunner({ spawnFn, hostEnv: {} });

    await runner.start({ task: TASK, prompt: "x", allowedTools: ["Read"], worktreeDir: "/wt" });

    const [, , options] = spawnFn.mock.calls[0];
    expect(options.detached).toBe(true);
  });

  it("start() never leaves stdin as an open, unwritten pipe -- the real CLI blocks forever reading it otherwise", async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const runner = new ClaudeCliRunner({ spawnFn, hostEnv: {} });

    await runner.start({ task: TASK, prompt: "x", allowedTools: ["Read"], worktreeDir: "/wt" });

    const [, , options] = spawnFn.mock.calls[0];
    expect(options.stdio[0]).toBe("ignore");
  });
});

describe("ClaudeCliRunner.kill process-group behavior (no orphans)", () => {
  it("kills a detached child's whole process group, so a grandchild it spawned dies too", async () => {
    const child = nodeSpawn("bash", ["-c", "sleep 50 & echo $!; wait"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"]
    });

    const grandchildPid = await new Promise((resolve) => {
      child.stdout.on("data", (chunk) => resolve(Number.parseInt(chunk.toString().trim(), 10)));
    });

    expect(isAlive(child.pid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    runner.kill({ child });

    await vi.waitFor(() => {
      expect(isAlive(child.pid)).toBe(false);
      expect(isAlive(grandchildPid)).toBe(false);
    });
  });

  it("falls back to child.kill() when the child has no pid to target a process group with", () => {
    const child = fakeChild();
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });

    runner.kill({ child });

    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("escalates to SIGKILL on the process group if the child hasn't exited within the escalation window", () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.pid = 5555;
      child.kill = vi.fn();
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});
      const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });

      runner.kill({ child });
      expect(killSpy).toHaveBeenCalledWith(-5555, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-5555, "SIGKILL");

      vi.advanceTimersByTime(DEFAULT_KILL_ESCALATION_MS);

      expect(killSpy).toHaveBeenCalledWith(-5555, "SIGKILL");
      killSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the SIGKILL escalation once the child actually exits (from the initial SIGTERM)", () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.pid = 5556;
      child.kill = vi.fn();
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});
      const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });

      runner.kill({ child });
      child.emit("exit", null, "SIGTERM");
      killSpy.mockClear();

      vi.advanceTimersByTime(DEFAULT_KILL_ESCALATION_MS);

      expect(killSpy).not.toHaveBeenCalled();
      killSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("really kills a process that ignores SIGTERM by escalating to SIGKILL on its process group", async () => {
    // A forked grandchild (e.g. `sleep`) dies to plain SIGTERM regardless of the parent's own
    // trap, so this has the group leader itself ignore TERM in a tight builtin loop (no fork) --
    // the only way to reliably prove escalation is what saves it, verified by hand first. Prints
    // "READY" only once the trap is actually installed, so the test never races bash's own
    // startup (a raw pid-exists check says nothing about how far into the script it's gotten).
    const child = nodeSpawn("bash", ["-c", "trap '' TERM; echo READY; while true; do :; done"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    await new Promise((resolve) => {
      child.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("READY")) resolve();
      });
    });
    expect(isAlive(child.pid)).toBe(true);

    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    // A generous escalation window (well above typical scheduler jitter in a loaded CI/WSL
    // environment) so the "still alive" check below can't lose the race against the escalation
    // timer itself.
    runner.kill({ child }, { escalationMs: 2000 });

    // Still alive shortly after SIGTERM (comfortably inside the escalation window) -- trapped, ignored.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(child.pid)).toBe(true);

    await vi.waitFor(() => expect(isAlive(child.pid)).toBe(false), { timeout: 8000 });
  });
});
