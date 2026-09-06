import { describe, it, expect, vi } from "vitest";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { AgentRunner } from "../../src/runner/agentRunner.js";
import { ClaudeCliRunner, DEFAULT_ENV_ALLOWLIST } from "../../src/runner/claudeCliRunner.js";
import { DEFAULT_KILL_ESCALATION_MS } from "../../src/runner/runState.js";

const TASK = { id: "T-0099", agent: "infra" };

function fakeChild() {
  return { stdout: {}, stderr: {}, stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() }, kill: vi.fn(), on: vi.fn() };
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

  it("constructs the exact argv for a task run -- the prompt is never one of its elements (T-0291: argv has a MAX_ARG_STRLEN ceiling; the prompt travels over stdin instead, see start())", () => {
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
      "Read Write Bash(git:*)"
    ]);
    expect(invocation.cwd).toBe("/repo/worktrees/T-0099");
    expect(invocation.prompt).toBe("do the thing");
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

  it("carries the prompt on the invocation for start() to deliver over stdin, not as an argv element", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    const invocation = runner.buildInvocation({
      task: TASK,
      prompt: "the exact prompt text",
      allowedTools: ["Read"],
      worktreeDir: "/wt"
    });
    expect(invocation.prompt).toBe("the exact prompt text");
    expect(invocation.args).not.toContain("the exact prompt text");
  });

  it("never puts the prompt in argv regardless of size -- a 256 KB card body (T-0243: well past the OS's per-argument MAX_ARG_STRLEN ceiling, ~128 KiB on Linux) must not make argv grow at all", () => {
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv: {} });
    const hugePrompt = "x".repeat(256 * 1024);
    const invocation = runner.buildInvocation({
      task: TASK,
      prompt: hugePrompt,
      allowedTools: ["Read"],
      worktreeDir: "/wt"
    });
    expect(invocation.args.every((arg) => arg !== hugePrompt)).toBe(true);
    const totalArgvBytes = invocation.args.reduce((sum, arg) => sum + Buffer.byteLength(arg), 0);
    expect(totalArgvBytes).toBeLessThan(1024);
    expect(invocation.prompt).toBe(hugePrompt);
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

  it("passes BOARD_TASK_STORE and BOARD_DB_PATH through to the child, so a db-mode reviewer/implementer run (and any checkDeliverable.js/checkPlannerDiffGuard.js/validateBacklog.js it invokes via Bash) resolves the live SQLite store instead of silently falling back to fs mode", () => {
    const hostEnv = {
      PATH: "/usr/bin",
      BOARD_TASK_STORE: "db",
      BOARD_DB_PATH: "/home/dennieseth/.local/share/assembled-board/board.db"
    };
    const runner = new ClaudeCliRunner({ spawnFn: vi.fn(), hostEnv });
    const invocation = runner.buildInvocation({
      task: TASK,
      prompt: "x",
      allowedTools: ["Read"],
      worktreeDir: "/wt"
    });
    expect(invocation.env.BOARD_TASK_STORE).toBe("db");
    expect(invocation.env.BOARD_DB_PATH).toBe("/home/dennieseth/.local/share/assembled-board/board.db");
  });

  it("includes BOARD_TASK_STORE and BOARD_DB_PATH in the default allowlist", () => {
    expect(DEFAULT_ENV_ALLOWLIST).toContain("BOARD_TASK_STORE");
    expect(DEFAULT_ENV_ALLOWLIST).toContain("BOARD_DB_PATH");
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
    expect(args).not.toContain("do the thing");
    expect(child.stdin.write).toHaveBeenCalledWith("do the thing");
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

  it("start() delivers the prompt over stdin (not argv) and closes it -- a real CLI's own stdin probe never blocks waiting for more input than was written", async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const runner = new ClaudeCliRunner({ spawnFn, hostEnv: {} });

    await runner.start({ task: TASK, prompt: "the prompt text", allowedTools: ["Read"], worktreeDir: "/wt" });

    const [, , options] = spawnFn.mock.calls[0];
    expect(options.stdio[0]).toBe("pipe");
    expect(child.stdin.write).toHaveBeenCalledWith("the prompt text");
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    // end() must come after write() -- ending first would truncate the prompt.
    const writeOrder = child.stdin.write.mock.invocationCallOrder[0];
    const endOrder = child.stdin.end.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(endOrder);
  });

  it("start() never leaves a spawn failure (e.g. E2BIG) as an uncaught synchronous throw -- it comes back as a normal run handle with spawnError set, the same shape the async ENOENT path already produces", async () => {
    const err = Object.assign(new Error("spawn claude E2BIG"), { code: "E2BIG" });
    const spawnFn = vi.fn(() => {
      throw err;
    });
    const runner = new ClaudeCliRunner({ spawnFn, hostEnv: {} });

    let run;
    await expect(
      (async () => {
        run = await runner.start({ task: TASK, prompt: "x".repeat(300 * 1024), allowedTools: ["Read"], worktreeDir: "/wt" });
      })()
    ).resolves.not.toThrow();

    expect(run.spawnError).toBe(err);
    expect(run.runId).toBe(TASK.id);
  });

  it("start() attaches its own 'error' listener synchronously, so a spawn failure (e.g. ENOENT) never becomes an unlistened 'error' event that crashes the process", async () => {
    // A real EventEmitter, not the fakeChild() stub -- fakeChild's `on` is a no-op vi.fn() that
    // never actually registers anything, which would hide the exact failure mode this guards
    // against (Node throwing synchronously when 'error' is emitted with zero real listeners).
    const child = new EventEmitter();
    child.stdout = {};
    child.stderr = {};
    child.kill = vi.fn();
    const spawnFn = vi.fn(() => child);
    const runner = new ClaudeCliRunner({ spawnFn, hostEnv: {} });

    await runner.start({ task: TASK, prompt: "x", allowedTools: ["Read"], worktreeDir: "/wt" });

    // This incident: spawn('claude', ...) fails with ENOENT because `claude` isn't resolvable
    // on the child's PATH, Node emits 'error' on the child asynchronously, and with no listener
    // attached at that instant it throws as an uncaught exception -- taking the whole board
    // server down over a single card's run. Proving this doesn't throw is the actual fix.
    expect(() => child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }))).not.toThrow();
  });

  it("captures a spawn error onto run.spawnError, so a caller whose own listener attaches too late (after async I/O) can still observe the failure", async () => {
    const child = new EventEmitter();
    child.stdout = {};
    child.stderr = {};
    child.kill = vi.fn();
    const spawnFn = vi.fn(() => child);
    const runner = new ClaudeCliRunner({ spawnFn, hostEnv: {} });

    const run = await runner.start({ task: TASK, prompt: "x", allowedTools: ["Read"], worktreeDir: "/wt" });
    expect(run.spawnError).toBeNull();

    // Simulates the error arriving before runOrchestrator._runPhase gets around to attaching
    // its own 'error' listener (it does an async writeRunStateFn write in between) -- a real
    // race, not a hypothetical one; see the T-0185 incident.
    const err = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    child.emit("error", err);

    expect(run.spawnError).toBe(err);
  });
});

describe("ClaudeCliRunner.start -- large prompt over stdin (T-0291: spawn E2BIG)", () => {
  it("spawns successfully with a 256 KB prompt -- well past the OS's ~128 KiB per-argument MAX_ARG_STRLEN ceiling that crashed T-0243 -- because the prompt travels over stdin, not argv", async () => {
    // A real, unmocked child process (not the `claude` CLI itself, which would require real
    // auth/network -- `cat` stands in as "a process that reads all of stdin and echoes it back",
    // proving the plumbing end to end: spawn doesn't throw, and the full prompt arrives intact).
    // Before this fix, embedding a prompt this size as an argv element reproduces T-0243's
    // `spawn E2BIG` reliably (see the synchronous-throw characterization in the "start() never
    // leaves a spawn failure ... as an uncaught synchronous throw" test above).
    const hugePrompt = "x".repeat(256 * 1024);
    const runner = new ClaudeCliRunner({ hostEnv: {} });
    // Swap in "cat" with no extra argv -- this test is about start()'s stdin plumbing surviving
    // a huge prompt, not about the real `claude` CLI's own flag parsing (which "cat" doesn't
    // share, and would choke on flags like -p/--allowedTools if we left them in argv).
    runner.buildInvocation = () => ({ command: "cat", args: [], cwd: process.cwd(), env: {}, prompt: hugePrompt });

    const run = await runner.start({
      task: TASK,
      prompt: hugePrompt,
      allowedTools: ["Read"],
      worktreeDir: process.cwd()
    });

    expect(run.spawnError).toBeNull();

    const output = await new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("cat did not echo the full prompt back within 5s")), 5000);
      run.child.stdout.on("data", (chunk) => {
        out += chunk.toString();
      });
      run.child.once("exit", () => {
        clearTimeout(timer);
        resolve(out);
      });
      run.child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(output).toBe(hugePrompt);
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

describe("stdin-hang hardening (T-0117): the outer spawn's stdio config is what the board controls", () => {
  it("a real child spawned with stdin ignored gets immediate EOF -- a bare `cat` with no input does not hang", async () => {
    // T-0291 moved ClaudeCliRunner.start()'s own stdio to ["pipe", "pipe", "pipe"] so the
    // prompt itself can travel over stdin instead of argv (see the "delivers the prompt over
    // stdin" test above) -- that pipe is always explicitly written to and end()-ed, so it can
    // never be the *unwritten, unclosed* pipe this test is about. This test instead documents
    // the general fact that motivated 'ignore' in the first place and still matters wherever
    // stdin has nothing to write to it: a real, unmocked child process proving a bare
    // `cat`/`grep`/`read` with no input doesn't hang forever on an ignored ("ignore" -> /dev/null)
    // stdin. It does NOT prove anything about commands the `claude` CLI spawns internally for its
    // own Bash tool -- see runOrchestrator.js's DEFAULT_INACTIVITY_TIMEOUT_MS docstring for why
    // that's a separate, non-board-controlled problem the inactivity watchdog exists to catch
    // instead.
    const child = nodeSpawn("bash", ["-c", "cat; echo DONE"], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const output = await new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("hung: bare `cat` did not exit within 5s of an ignored stdin")), 5000);
      child.stdout.on("data", (chunk) => {
        out += chunk.toString();
      });
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(out);
      });
    });

    expect(output).toContain("DONE");
  });
});
