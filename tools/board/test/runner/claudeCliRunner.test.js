import { describe, it, expect, vi } from "vitest";
import { AgentRunner } from "../../src/runner/agentRunner.js";
import { ClaudeCliRunner } from "../../src/runner/claudeCliRunner.js";

const TASK = { id: "T-0099", agent: "infra" };

function fakeChild() {
  return { stdout: {}, stderr: {}, kill: vi.fn(), on: vi.fn() };
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
});
