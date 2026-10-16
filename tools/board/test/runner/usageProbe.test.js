import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  buildProbeArgs,
  spawnUsageProbe,
  defaultUsageProbeFn
} from "../../src/runner/usageProbe.js";

/**
 * T-0438 fix round: `usageProbe.js` -- the actual decision-time probe mechanism this card
 * delivers -- shipped with zero test coverage (`usageTelemetryFreshness.test.js` only exercises
 * the `usageProbeFn` injection seam in `usageTelemetry.js`/`autoLaunchPoller.js`, never this
 * module itself). This file drives `spawnUsageProbe` directly through an injected `spawnFn`,
 * the same pattern `claudeCliRunner.test.js` already uses, so the real `on("exit", ...)` /
 * `on("close", ...)` / kill-escalation logic in this module is actually exercised, not merely
 * implied by a docstring claiming it is.
 */

function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  child.kill = vi.fn();
  return child;
}

function rateLimitEventLine(overrides = {}) {
  return (
    JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        resetsAt: 9_999_999_999,
        utilization: 0.42,
        isUsingOverage: false,
        ...overrides
      },
      uuid: "54d022f9-8efd-43e7-a49f-67cac9a3e682",
      session_id: "18d5c168-5e17-4062-8f5a-4d502597766f"
    }) + "\n"
  );
}

describe("buildProbeArgs", () => {
  it("builds the minimal preflight invocation -- no --allowedTools, no --settings, no --model", () => {
    const args = buildProbeArgs();
    expect(args).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--settings");
    expect(args).not.toContain("--model");
  });
});

describe("spawnUsageProbe", () => {
  it("resolves with { rateLimitInfo } the instant a rate_limit_event line arrives on stdout", async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);

    const resultPromise = spawnUsageProbe({ spawnFn });
    child.stdout.emit("data", Buffer.from(rateLimitEventLine()));
    const result = await resultPromise;

    expect(result).toEqual({
      rateLimitInfo: expect.objectContaining({ rateLimitType: "five_hour", utilization: 0.42 })
    });
  });

  it("invokes spawnFn with buildProbeArgs() and a detached, fully-piped child", async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);

    const resultPromise = spawnUsageProbe({ spawnFn, command: "claude", env: { PATH: "/usr/bin" } });
    child.stdout.emit("data", Buffer.from(rateLimitEventLine()));
    await resultPromise;

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnFn.mock.calls[0];
    expect(command).toBe("claude");
    expect(args).toEqual(buildProbeArgs());
    expect(options.detached).toBe(true);
    expect(options.env).toEqual({ PATH: "/usr/bin" });
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("kills the child (its process group) once a usable reading has been seen -- the probe never runs past its own preflight", async () => {
    const child = fakeChild({ pid: 777 });
    const spawnFn = vi.fn(() => child);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});

    try {
      const resultPromise = spawnUsageProbe({ spawnFn });
      child.stdout.emit("data", Buffer.from(rateLimitEventLine()));
      await resultPromise;

      expect(killSpy).toHaveBeenCalledWith(-777, "SIGTERM");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("resolves null when spawnFn throws synchronously", async () => {
    const spawnFn = vi.fn(() => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    });

    const result = await spawnUsageProbe({ spawnFn });

    expect(result).toBeNull();
  });

  it("resolves null when the child emits an 'error' event", async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);

    const resultPromise = spawnUsageProbe({ spawnFn });
    child.emit("error", new Error("spawn claude ENOENT"));

    expect(await resultPromise).toBeNull();
  });

  it("resolves null on timeout, without ever calling a usable reading a guess", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const spawnFn = vi.fn(() => child);

      const resultPromise = spawnUsageProbe({ spawnFn, timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await resultPromise).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves null if the child closes having never emitted a usable event", async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);

    const resultPromise = spawnUsageProbe({ spawnFn });
    child.emit("close", 0);

    expect(await resultPromise).toBeNull();
  });

  it(
    "a rate_limit_event line delivered on stdout AFTER the child's own 'exit' fires is still captured -- " +
      "Node's 'exit' can fire while stdio is still flushing buffered output ('close' is the flush-complete " +
      "event), so a probe that resolves null as soon as it sees 'exit' can silently discard a reading that " +
      "was already on its way, defeating the whole point of the probe",
    async () => {
      const child = fakeChild();
      const spawnFn = vi.fn(() => child);

      const resultPromise = spawnUsageProbe({ spawnFn });
      child.emit("exit", 0, null);
      child.stdout.emit("data", Buffer.from(rateLimitEventLine()));
      child.emit("close", 0);

      const result = await resultPromise;
      expect(result).toEqual({
        rateLimitInfo: expect.objectContaining({ rateLimitType: "five_hour", utilization: 0.42 })
      });
    }
  );

  it("falls back to a bare child.kill() when the child has no pid to target a process group with", async () => {
    const child = fakeChild();
    child.pid = undefined;
    const spawnFn = vi.fn(() => child);

    const resultPromise = spawnUsageProbe({ spawnFn });
    child.stdout.emit("data", Buffer.from(rateLimitEventLine()));
    await resultPromise;

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("escalates to SIGKILL on the process group if the child hasn't exited within the escalation window", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild({ pid: 888 });
      const spawnFn = vi.fn(() => child);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});

      const resultPromise = spawnUsageProbe({ spawnFn, killEscalationMs: 3_000 });
      child.stdout.emit("data", Buffer.from(rateLimitEventLine()));
      await resultPromise;
      killSpy.mockClear();

      await vi.advanceTimersByTimeAsync(3_000);

      expect(killSpy).toHaveBeenCalledWith(-888, "SIGKILL");
      killSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the SIGKILL escalation once the child actually exits from the initial SIGTERM", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild({ pid: 889 });
      const spawnFn = vi.fn(() => child);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});

      const resultPromise = spawnUsageProbe({ spawnFn, killEscalationMs: 3_000 });
      child.stdout.emit("data", Buffer.from(rateLimitEventLine()));
      await resultPromise;
      child.emit("exit", null, "SIGTERM");
      killSpy.mockClear();

      await vi.advanceTimersByTimeAsync(3_000);

      expect(killSpy).not.toHaveBeenCalled();
      killSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes a single throwaway byte to stdin and closes it -- never leaves the child waiting on input it won't get", async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);

    const resultPromise = spawnUsageProbe({ spawnFn });
    child.stdout.emit("data", Buffer.from(rateLimitEventLine()));
    await resultPromise;

    expect(child.stdin.write).toHaveBeenCalledWith(".");
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
  });

  it("default DEFAULT_PROBE_TIMEOUT_MS is a sane positive bound", () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("defaultUsageProbeFn", () => {
  it("refuses to probe any window kind other than five_hour, without spawning anything", async () => {
    const result = await defaultUsageProbeFn({ windowKind: "seven_day" });
    expect(result).toBeNull();
  });

  it("refuses when windowKind is omitted entirely", async () => {
    const result = await defaultUsageProbeFn({});
    expect(result).toBeNull();
  });
});
