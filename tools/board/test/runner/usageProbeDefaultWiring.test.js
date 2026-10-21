import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmTemp } from "../helpers/rmTemp.js";

/**
 * T-0438 fix round 3: the prior round's end-to-end demonstration (usageTelemetryFreshness.test.js)
 * always passed an injected `usageProbeFn` double -- it proved the WIRING works, never that the
 * branch head's own DEFAULT actually does the wiring. Reviewer FAIL (2026-10-16T13:56:39.202Z,
 * criterion 1): with nothing overridden, `createAutoLaunchPoller`'s `usageProbeFn` defaulted to
 * `null` unless `USAGE_PROBE_ENABLED` was explicitly set, so the branch head still classified
 * `five_hour` as `stale` at decision time -- exactly the bug this card exists to fix, reproduced
 * by its own default configuration.
 *
 * This file mocks ONLY the OS-level `node:child_process.spawn` -- not `usageProbeFn`, not
 * `readUsageTelemetryFn` -- and drives the real `createAutoLaunchPoller` default parameter
 * straight through `usageProbe.js`'s real `defaultUsageProbeFn`/`spawnUsageProbe` and
 * `usageTelemetry.js`'s real `readUsageTelemetry`/`readWindowUsage`. If the default wiring ever
 * regresses back to `null`, this is the test that catches it.
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
        utilization: 0.37,
        isUsingOverage: false,
        ...overrides
      },
      uuid: "54d022f9-8efd-43e7-a49f-67cac9a3e682",
      session_id: "18d5c168-5e17-4062-8f5a-4d502597766f"
    }) + "\n"
  );
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});

const { spawn } = await import("node:child_process");
const { createAutoLaunchPoller } = await import("../../src/runner/autoLaunchPoller.js");

function makeTask(overrides = {}) {
  return {
    id: "T-0001",
    title: "A card",
    status: "ready",
    priority: "P1",
    phase: "P1",
    agent: "server",
    depends_on: [],
    created: "2026-08-29",
    body: "",
    ...overrides
  };
}

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function logLines(logger) {
  return logger.log.mock.calls.map((call) => call[0]).join("\n");
}

describe("createAutoLaunchPoller -- default usageProbeFn wiring, nothing but the OS spawn mocked (T-0438)", () => {
  let runsDir;
  let killSpy;
  const originalDisabled = process.env.USAGE_PROBE_DISABLED;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-usage-default-wiring-"));
    delete process.env.USAGE_PROBE_DISABLED;
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});
    spawn.mockReset();
  });

  afterEach(async () => {
    await rmTemp(runsDir);
    killSpy.mockRestore();
    if (originalDisabled === undefined) delete process.env.USAGE_PROBE_DISABLED;
    else process.env.USAGE_PROBE_DISABLED = originalDisabled;
  });

  it("on an idle runsDir, with nothing overridden, the poller's own default probes the CLI and logs a non-null five_hour utilization", async () => {
    const child = fakeChild();
    spawn.mockImplementation(() => child);

    const store = { list: vi.fn(async () => [makeTask()]) };
    const orchestrator = { hasActiveRuns: vi.fn(() => false) };
    const logger = makeLogger();
    const launchFn = vi.fn(async ({ id }) => makeTask({ id }));

    const poller = createAutoLaunchPoller({
      store,
      orchestrator,
      runsDir,
      enabled: true,
      intervalMs: 1_800_000,
      usageMax: 0.8,
      readUsage: vi.fn(async () => ({ utilization: null, status: null, logPath: null, telemetryAbsent: true, reason: "no rate-limit telemetry" })),
      launchFn,
      logger,
      now: () => 1_788_000_000_000
      // usageProbeFn deliberately omitted -- this is the branch head's own default.
    });

    const tickPromise = poller.tick();
    // The real readUsageTelemetry scan does real filesystem I/O (readdir on runsDir) before
    // withFreshProbe ever calls spawnUsageProbe -- a microtask-only await isn't enough ticks for
    // that to land, so wait for the real spawn call itself before delivering its stdout.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.stdout.emit("data", Buffer.from(rateLimitEventLine()));
    await tickPromise;

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args] = spawn.mock.calls[0];
    expect(command).toBe("claude");
    expect(args).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);

    const lines = logLines(logger);
    expect(lines).toMatch(/usage gate comparison/);
    expect(lines).toMatch(/five_hour=ok\(0\.37\)/);
    expect(lines).not.toMatch(/five_hour=unknown/);
  });

  it("USAGE_PROBE_DISABLED=1 opts back out, reproducing the pre-T-0438 scan-only behavior with nothing wired in", async () => {
    process.env.USAGE_PROBE_DISABLED = "1";

    const store = { list: vi.fn(async () => [makeTask()]) };
    const orchestrator = { hasActiveRuns: vi.fn(() => false) };
    const logger = makeLogger();

    const poller = createAutoLaunchPoller({
      store,
      orchestrator,
      runsDir,
      enabled: true,
      intervalMs: 1_800_000,
      usageMax: 0.8,
      readUsage: vi.fn(async () => ({ utilization: null, status: null, logPath: null, telemetryAbsent: true, reason: "no rate-limit telemetry" })),
      launchFn: vi.fn(async ({ id }) => makeTask({ id })),
      logger,
      now: () => 1_788_000_000_000
    });

    await poller.tick();

    expect(spawn).not.toHaveBeenCalled();
    expect(logLines(logger)).toMatch(/five_hour=unknown\(unavailable\)/);
  });
});
