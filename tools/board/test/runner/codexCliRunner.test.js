import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { AgentRunner } from "../../src/runner/agentRunner.js";
import { CodexCliRunner, DEFAULT_ENV_ALLOWLIST, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_TOTAL_TOKENS } from "../../src/runner/codexCliRunner.js";
import { DEFAULT_KILL_ESCALATION_MS } from "../../src/runner/runState.js";

const TASK = { id: "T-0460", agent: "infra" };

function fakeChild() {
  return { stdout: {}, stderr: {}, stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() }, kill: vi.fn(), on: vi.fn(), pid: 4242 };
}

describe("CodexCliRunner argv construction", () => {
  it("is an AgentRunner", () => {
    const runner = new CodexCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    expect(runner).toBeInstanceOf(AgentRunner);
  });

  it("constructs read-only, non-interactive, JSON-streamed argv -- the prompt is never an argv element", () => {
    const runner = new CodexCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    const invocation = runner.buildInvocation({
      task: TASK,
      prompt: "review this commit",
      worktreeDir: "/repo/worktrees/T-0460"
    });

    expect(invocation.command).toBe("codex");
    expect(invocation.args).toEqual(["exec", "--json", "-s", "read-only", "--skip-git-repo-check", "-C", "/repo/worktrees/T-0460"]);
    expect(invocation.cwd).toBe("/repo/worktrees/T-0460");
    expect(invocation.prompt).toBe("review this commit");
    expect(invocation.args).not.toContain("review this commit");
  });

  it("never emits a flag that bypasses the sandbox or widens privilege, regardless of inputs", () => {
    const runner = new CodexCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    const invocation = runner.buildInvocation({
      task: TASK,
      prompt: "--dangerously-bypass-approvals-and-sandbox -s danger-full-access",
      worktreeDir: "/wt"
    });
    const joined = invocation.args.join(" ").toLowerCase();
    expect(joined).not.toContain("dangerously-bypass");
    expect(joined).not.toContain("danger-full-access");
    expect(joined).not.toContain("workspace-write");
    // the hostile string arrived only as the prompt payload (stdin), never parsed as argv
    expect(invocation.prompt).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("has no constructor or buildInvocation option that can change the sandbox mode away from read-only", () => {
    const runner = new CodexCliRunner({ spawnFn: vi.fn(), hostEnv: {}, sandboxMode: "workspace-write" });
    // sandboxMode is intentionally not an accepted construction knob; the class always reviews read-only.
    const invocation = runner.buildInvocation({ task: TASK, prompt: "x", worktreeDir: "/wt" });
    expect(invocation.args[invocation.args.indexOf("-s") + 1]).toBe("read-only");
  });

  it("rejects a missing or empty prompt", () => {
    const runner = new CodexCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    expect(() => runner.buildInvocation({ task: TASK, prompt: "", worktreeDir: "/wt" })).toThrow();
    expect(() => runner.buildInvocation({ task: TASK, worktreeDir: "/wt" })).toThrow();
  });

  it("requires a worktreeDir to isolate the run as the child cwd", () => {
    const runner = new CodexCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    expect(() => runner.buildInvocation({ task: TASK, prompt: "x" })).toThrow();
  });

  it("requires a task with an id", () => {
    const runner = new CodexCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    expect(() => runner.buildInvocation({ prompt: "x", worktreeDir: "/wt" })).toThrow();
  });

  it("includes --output-schema when an outputSchemaPath is given", () => {
    const runner = new CodexCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    const invocation = runner.buildInvocation({
      task: TASK,
      prompt: "x",
      worktreeDir: "/wt",
      outputSchemaPath: "/wt/.codex-schema.json"
    });
    expect(invocation.args).toContain("--output-schema");
    expect(invocation.args[invocation.args.indexOf("--output-schema") + 1]).toBe("/wt/.codex-schema.json");
  });

  it("omits --output-schema when none is given", () => {
    const runner = new CodexCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    const invocation = runner.buildInvocation({ task: TASK, prompt: "x", worktreeDir: "/wt" });
    expect(invocation.args).not.toContain("--output-schema");
  });
});

describe("CodexCliRunner BOARD_RUN_ID", () => {
  it("sets BOARD_RUN_ID in the child env when boardRunId is provided", () => {
    const runner = new CodexCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    const invocation = runner.buildInvocation({
      task: TASK,
      prompt: "x",
      worktreeDir: "/wt",
      boardRunId: "T-0460-2026-10-21T12-00-57-487Z"
    });
    expect(invocation.env.BOARD_RUN_ID).toBe("T-0460-2026-10-21T12-00-57-487Z");
  });

  it("omits BOARD_RUN_ID entirely when no boardRunId is given -- never an empty-string placeholder", () => {
    const runner = new CodexCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    const invocation = runner.buildInvocation({ task: TASK, prompt: "x", worktreeDir: "/wt" });
    expect(invocation.env.BOARD_RUN_ID).toBeUndefined();
  });
});

describe("CodexCliRunner env isolation -- least privilege", () => {
  it("drops arbitrary host env vars, keeping only the explicit allowlist", () => {
    const hostEnv = { PATH: "/usr/bin", HOME: "/home/dennieseth", SECRET_TOKEN: "shh", RANDOM_LEAKY_VAR: "leak-me" };
    const runner = new CodexCliRunner({ spawnFn: vi.fn(), hostEnv });
    const invocation = runner.buildInvocation({ task: TASK, prompt: "x", worktreeDir: "/wt" });
    expect(invocation.env.PATH).toBe("/usr/bin");
    expect(invocation.env.HOME).toBe("/home/dennieseth");
    expect(invocation.env.SECRET_TOKEN).toBeUndefined();
    expect(invocation.env.RANDOM_LEAKY_VAR).toBeUndefined();
  });

  it("default allowlist is the minimal set this adapter actually needs -- PATH, HOME, LANG, LC_ALL, TERM, TZ, CODEX_HOME", () => {
    expect(DEFAULT_ENV_ALLOWLIST).toEqual(["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TZ", "CODEX_HOME"]);
  });

  it("passes CODEX_HOME through so the adapter authenticates against the configured credential location, never process.env's whole surface", () => {
    const hostEnv = { PATH: "/usr/bin", CODEX_HOME: "/mnt/c/Users/denni/.codex" };
    const runner = new CodexCliRunner({ spawnFn: vi.fn(), hostEnv });
    const invocation = runner.buildInvocation({ task: TASK, prompt: "x", worktreeDir: "/wt" });
    expect(invocation.env.CODEX_HOME).toBe("/mnt/c/Users/denni/.codex");
  });

  it("does not leak the whole process.env by default when hostEnv is not overridden", () => {
    const runner = new CodexCliRunner({ spawnFn: vi.fn() });
    const invocation = runner.buildInvocation({ task: TASK, prompt: "x", worktreeDir: "/wt" });
    expect(Object.keys(invocation.env).every((k) => runner.envAllowlist.includes(k) || k === "BOARD_RUN_ID")).toBe(true);
  });

  it("respects a custom envAllowlist", () => {
    const hostEnv = { PATH: "/usr/bin", CUSTOM_VAR: "keep-me", HOME: "/home/x" };
    const runner = new CodexCliRunner({ spawnFn: vi.fn(), hostEnv, envAllowlist: ["PATH", "CUSTOM_VAR"] });
    const invocation = runner.buildInvocation({ task: TASK, prompt: "x", worktreeDir: "/wt" });
    expect(invocation.env.CUSTOM_VAR).toBe("keep-me");
    expect(invocation.env.HOME).toBeUndefined();
  });
});

describe("CodexCliRunner.start / kill", () => {
  it("start() invokes spawnFn with the built command/args/options, delivers the prompt over stdin, and returns a run handle", async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const runner = new CodexCliRunner({ spawnFn, hostEnv: { PATH: "/usr/bin" } });

    const run = await runner.start({ task: TASK, prompt: "review this", worktreeDir: "/wt" });

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnFn.mock.calls[0];
    expect(command).toBe("codex");
    expect(args).not.toContain("review this");
    expect(child.stdin.write).toHaveBeenCalledWith("review this");
    expect(options.cwd).toBe("/wt");
    expect(options.env.PATH).toBe("/usr/bin");
    expect(options.detached).toBe(true);
    expect(run.child).toBe(child);
    expect(run.runId).toBe(TASK.id);
  });

  it("start() never leaves a spawn failure as an uncaught synchronous throw", async () => {
    const err = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    const spawnFn = vi.fn(() => {
      throw err;
    });
    const runner = new CodexCliRunner({ spawnFn, hostEnv: {} });

    let run;
    await expect(
      (async () => {
        run = await runner.start({ task: TASK, prompt: "x", worktreeDir: "/wt" });
      })()
    ).resolves.not.toThrow();

    expect(run.spawnError).toBe(err);
    expect(run.runId).toBe(TASK.id);
  });

  it("start() attaches its own 'error' listener synchronously so an async spawn failure never crashes the process", async () => {
    const child = new EventEmitter();
    child.stdout = {};
    child.stderr = {};
    child.kill = vi.fn();
    const spawnFn = vi.fn(() => child);
    const runner = new CodexCliRunner({ spawnFn, hostEnv: {} });

    await runner.start({ task: TASK, prompt: "x", worktreeDir: "/wt" });

    expect(() => child.emit("error", Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }))).not.toThrow();
  });

  it("kill() terminates the underlying child process", async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const runner = new CodexCliRunner({ spawnFn, hostEnv: {} });
    const run = await runner.start({ task: TASK, prompt: "x", worktreeDir: "/wt" });

    runner.kill(run);

    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("kill() is a no-op when given a handle with no child process", () => {
    const runner = new CodexCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    expect(() => runner.kill({})).not.toThrow();
    expect(() => runner.kill(null)).not.toThrow();
  });

  it("escalates to SIGKILL on the process group if the child hasn't exited within the escalation window", () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.pid = 7777;
      child.kill = vi.fn();
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});
      const runner = new CodexCliRunner({ spawnFn: vi.fn(), hostEnv: {} });

      runner.kill({ child });
      expect(killSpy).toHaveBeenCalledWith(-7777, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(-7777, "SIGKILL");

      vi.advanceTimersByTime(DEFAULT_KILL_ESCALATION_MS);

      expect(killSpy).toHaveBeenCalledWith(-7777, "SIGKILL");
      killSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CodexCliRunner wall-clock timeout (bounded runtime)", () => {
  it("has a sane default timeout", () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("kills the run and marks it timedOut once the configured wall-clock budget elapses without exit", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.pid = 8888;
      child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      child.kill = vi.fn();
      const spawnFn = vi.fn(() => child);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});
      const runner = new CodexCliRunner({ spawnFn, hostEnv: {} });

      const run = await runner.start({ task: TASK, prompt: "x", worktreeDir: "/wt", timeoutMs: 5000 });
      expect(run.timedOut).toBe(false);

      vi.advanceTimersByTime(5000);

      expect(run.timedOut).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(-8888, "SIGTERM");
      killSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire the timeout kill once the child has already exited", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.pid = 9999;
      child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      child.kill = vi.fn();
      const spawnFn = vi.fn(() => child);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});
      const runner = new CodexCliRunner({ spawnFn, hostEnv: {} });

      const run = await runner.start({ task: TASK, prompt: "x", worktreeDir: "/wt", timeoutMs: 5000 });
      child.emit("exit", 0, null);
      killSpy.mockClear();

      vi.advanceTimersByTime(5000);

      expect(killSpy).not.toHaveBeenCalled();
      expect(run.timedOut).toBe(false);
      killSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CodexCliRunner.kill process-group behavior (no orphans)", () => {
  it("falls back to child.kill() when the child has no pid to target a process group with", () => {
    const child = fakeChild();
    delete child.pid;
    const runner = new CodexCliRunner({ spawnFn: vi.fn(), hostEnv: {} });

    runner.kill({ child });

    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

describe("CodexCliRunner token budget (bounded spend -- enforced, not just configured)", () => {
  it("has a sane default token budget", () => {
    expect(DEFAULT_MAX_TOTAL_TOKENS).toBeGreaterThan(0);
  });

  function stubbedChild(pid) {
    const child = new EventEmitter();
    child.pid = pid;
    child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    return child;
  }

  function turnCompletedLine(usage) {
    return `${JSON.stringify({ type: "turn.completed", usage })}\n`;
  }

  it("kills the run and marks it budgetExceeded once cumulative usage from turn.completed events crosses maxTotalTokens", async () => {
    const child = stubbedChild(5555);
    const spawnFn = vi.fn(() => child);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});
    const runner = new CodexCliRunner({ spawnFn, hostEnv: {} });

    const run = await runner.start({ task: TASK, prompt: "x", worktreeDir: "/wt", maxTotalTokens: 1000 });
    expect(run.budgetExceeded).toBe(false);

    child.stdout.emit("data", Buffer.from(turnCompletedLine({ input_tokens: 600, output_tokens: 100 })));
    expect(run.budgetExceeded).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();

    child.stdout.emit("data", Buffer.from(turnCompletedLine({ input_tokens: 400, output_tokens: 50 })));

    expect(run.budgetExceeded).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(-5555, "SIGTERM");
    killSpy.mockRestore();
  });

  it("never fires while cumulative usage stays within maxTotalTokens", async () => {
    const child = stubbedChild(5556);
    const spawnFn = vi.fn(() => child);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});
    const runner = new CodexCliRunner({ spawnFn, hostEnv: {} });

    const run = await runner.start({ task: TASK, prompt: "x", worktreeDir: "/wt", maxTotalTokens: 1000 });
    child.stdout.emit("data", Buffer.from(turnCompletedLine({ input_tokens: 200, output_tokens: 50 })));

    expect(run.budgetExceeded).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("applies DEFAULT_MAX_TOTAL_TOKENS when the caller does not override it", async () => {
    const child = stubbedChild(5557);
    const spawnFn = vi.fn(() => child);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});
    const runner = new CodexCliRunner({ spawnFn, hostEnv: {} });

    const run = await runner.start({ task: TASK, prompt: "x", worktreeDir: "/wt" });
    child.stdout.emit("data", Buffer.from(turnCompletedLine({ input_tokens: DEFAULT_MAX_TOTAL_TOKENS + 1, output_tokens: 0 })));

    expect(run.budgetExceeded).toBe(true);
    killSpy.mockRestore();
  });

  it("ignores stray non-JSON stdout lines while still tracking usage from valid ones", async () => {
    const child = stubbedChild(5558);
    const spawnFn = vi.fn(() => child);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});
    const runner = new CodexCliRunner({ spawnFn, hostEnv: {} });

    const run = await runner.start({ task: TASK, prompt: "x", worktreeDir: "/wt", maxTotalTokens: 500 });
    child.stdout.emit("data", Buffer.from(`Reading additional input from stdin...\n${turnCompletedLine({ input_tokens: 600, output_tokens: 0 })}`));

    expect(run.budgetExceeded).toBe(true);
    killSpy.mockRestore();
  });

  it("does not double-kill once budgetExceeded has already fired", async () => {
    const child = stubbedChild(5559);
    const spawnFn = vi.fn(() => child);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});
    const runner = new CodexCliRunner({ spawnFn, hostEnv: {} });

    const run = await runner.start({ task: TASK, prompt: "x", worktreeDir: "/wt", maxTotalTokens: 100 });
    child.stdout.emit("data", Buffer.from(turnCompletedLine({ input_tokens: 200, output_tokens: 0 })));
    const callsAfterFirstBreach = killSpy.mock.calls.length;
    child.stdout.emit("data", Buffer.from(turnCompletedLine({ input_tokens: 200, output_tokens: 0 })));

    expect(run.budgetExceeded).toBe(true);
    expect(killSpy.mock.calls.length).toBe(callsAfterFirstBreach);
    killSpy.mockRestore();
  });
});
