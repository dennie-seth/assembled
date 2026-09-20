import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAutoLaunchPoller,
  selectNextCard,
  evaluateWindowAwareUsageGate,
  autoLaunchEnabledFromEnv,
  autoLaunchIntervalMsFromEnv,
  autoLaunchUsageMaxFromEnv,
  DEFAULT_AUTO_LAUNCH_INTERVAL_MS,
  DEFAULT_AUTO_LAUNCH_USAGE_MAX
} from "../../src/runner/autoLaunchPoller.js";
import { CardLaunchError, LAUNCH_TRIGGERS } from "../../src/runner/cardLaunch.js";
import { READING_STATUS } from "../../src/runner/usageTelemetry.js";
import { orderCandidatesWithAging } from "../../src/runner/autoLaunchPoller.js";
import { createDrainWaitTracker, DEFAULT_DRAIN_CONFIG, DRAIN_STATUS, loadPersistedDrainWaitState } from "../../src/runner/drainMode.js";

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

function makeStore(tasks) {
  return {
    list: vi.fn(async () => tasks),
    get: vi.fn(async (id) => tasks.find((t) => t.id === id) ?? null),
    update: vi.fn(async (id, patch) => {
      const existing = tasks.find((t) => t.id === id) ?? { id };
      const updated = { ...existing, ...patch };
      tasks = tasks.map((t) => (t.id === id ? updated : t));
      return updated;
    })
  };
}

function makeOrchestrator({ active = false } = {}) {
  return { hasActiveRuns: vi.fn(() => active), isRunning: vi.fn(() => false), hub: { broadcast: vi.fn() } };
}

function makePoller({
  tasks = [makeTask()],
  active = false,
  usage = { utilization: 0, status: "allowed", logPath: "/runs/x.jsonl", reason: "status=allowed" },
  launchFn = vi.fn(async ({ id }) => makeTask({ id })),
  logger = makeLogger(),
  readUsageTelemetryFn = vi.fn(async () => ({
    five_hour: { windowKind: "five_hour", classification: "measured", utilization: 0, resetElapsed: false },
    seven_day: { windowKind: "seven_day", classification: "measured", utilization: 0, resetElapsed: false }
  })),
  ...overrides
} = {}) {
  const store = makeStore(tasks);
  const orchestrator = makeOrchestrator({ active });
  const readUsage = vi.fn(async () => usage);
  const poller = createAutoLaunchPoller({
    store,
    orchestrator,
    runsDir: "/runs",
    enabled: true,
    intervalMs: 1000,
    usageMax: 0.8,
    readUsage,
    readUsageTelemetryFn,
    launchFn,
    logger,
    ...overrides
  });
  return { poller, store, orchestrator, readUsage, readUsageTelemetryFn, launchFn, logger };
}

/** Every log line the poller emits carries this prefix, so a skip reason is greppable in the journal. */
function logLines(logger) {
  return logger.log.mock.calls.map((call) => call[0]).join("\n");
}

describe("autoLaunchEnabledFromEnv", () => {
  const original = process.env.AUTO_LAUNCH_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.AUTO_LAUNCH_ENABLED;
    else process.env.AUTO_LAUNCH_ENABLED = original;
  });

  it("defaults to OFF when unset -- deploying the code must not switch it on", () => {
    delete process.env.AUTO_LAUNCH_ENABLED;
    expect(autoLaunchEnabledFromEnv()).toBe(false);
  });

  it.each(["1", "true", "on", "yes", "TRUE", "On"])("is true when set to %s", (value) => {
    process.env.AUTO_LAUNCH_ENABLED = value;
    expect(autoLaunchEnabledFromEnv()).toBe(true);
  });

  it.each(["0", "false", "off", "no", "", "maybe"])("stays false for %s", (value) => {
    process.env.AUTO_LAUNCH_ENABLED = value;
    expect(autoLaunchEnabledFromEnv()).toBe(false);
  });
});

describe("autoLaunchIntervalMsFromEnv", () => {
  const original = process.env.AUTO_LAUNCH_INTERVAL_MS;

  afterEach(() => {
    if (original === undefined) delete process.env.AUTO_LAUNCH_INTERVAL_MS;
    else process.env.AUTO_LAUNCH_INTERVAL_MS = original;
  });

  it("defaults to 5 hours when unset -- one tick per Anthropic usage window", () => {
    delete process.env.AUTO_LAUNCH_INTERVAL_MS;
    expect(autoLaunchIntervalMsFromEnv()).toBe(DEFAULT_AUTO_LAUNCH_INTERVAL_MS);
    expect(DEFAULT_AUTO_LAUNCH_INTERVAL_MS).toBe(18000000);
    expect(DEFAULT_AUTO_LAUNCH_INTERVAL_MS).toBe(5 * 60 * 60 * 1000);
  });

  it("preserves an explicit 0 as the disable sentinel", () => {
    process.env.AUTO_LAUNCH_INTERVAL_MS = "0";
    expect(autoLaunchIntervalMsFromEnv()).toBe(0);
  });

  it("uses a valid positive override", () => {
    process.env.AUTO_LAUNCH_INTERVAL_MS = "60000";
    expect(autoLaunchIntervalMsFromEnv()).toBe(60000);
  });

  it.each(["not-a-number", "-1000"])("falls back to the default on %s", (value) => {
    process.env.AUTO_LAUNCH_INTERVAL_MS = value;
    expect(autoLaunchIntervalMsFromEnv()).toBe(DEFAULT_AUTO_LAUNCH_INTERVAL_MS);
  });
});

describe("autoLaunchUsageMaxFromEnv", () => {
  const original = process.env.AUTO_LAUNCH_USAGE_MAX;

  afterEach(() => {
    if (original === undefined) delete process.env.AUTO_LAUNCH_USAGE_MAX;
    else process.env.AUTO_LAUNCH_USAGE_MAX = original;
  });

  it("defaults to 0.80 when unset", () => {
    delete process.env.AUTO_LAUNCH_USAGE_MAX;
    expect(autoLaunchUsageMaxFromEnv()).toBe(DEFAULT_AUTO_LAUNCH_USAGE_MAX);
    expect(DEFAULT_AUTO_LAUNCH_USAGE_MAX).toBe(0.8);
  });

  it("uses a valid override inside 0..1", () => {
    process.env.AUTO_LAUNCH_USAGE_MAX = "0.5";
    expect(autoLaunchUsageMaxFromEnv()).toBe(0.5);
  });

  it.each(["1.5", "-0.1", "high"])("falls back to the default on out-of-range/garbage input (%s)", (value) => {
    process.env.AUTO_LAUNCH_USAGE_MAX = value;
    expect(autoLaunchUsageMaxFromEnv()).toBe(DEFAULT_AUTO_LAUNCH_USAGE_MAX);
  });
});

describe("selectNextCard", () => {
  it("returns null when nothing is ready", () => {
    expect(selectNextCard([makeTask({ status: "backlog" }), makeTask({ id: "T-0002", status: "done" })])).toBeNull();
  });

  it("only considers status exactly ready -- not review or blocked, which the Run button also accepts", () => {
    expect(selectNextCard([makeTask({ id: "T-0002", status: "review" }), makeTask({ id: "T-0003", status: "blocked" })])).toBeNull();
  });

  it("picks the highest priority (P0 over P1 over P2 over P3)", () => {
    const picked = selectNextCard([
      makeTask({ id: "T-0003", priority: "P2" }),
      makeTask({ id: "T-0001", priority: "P0" }),
      makeTask({ id: "T-0002", priority: "P1" })
    ]);
    expect(picked.id).toBe("T-0001");
  });

  it("ranks a missing/unknown priority below every real one", () => {
    const picked = selectNextCard([
      makeTask({ id: "T-0001", priority: null }),
      makeTask({ id: "T-0002", priority: "P3" })
    ]);
    expect(picked.id).toBe("T-0002");
  });

  it("breaks a priority tie by lowest numeric id, not string order", () => {
    const picked = selectNextCard([
      makeTask({ id: "T-0100", priority: "P1" }),
      makeTask({ id: "T-0021", priority: "P1" }),
      makeTask({ id: "T-0007", priority: "P1" })
    ]);
    expect(picked.id).toBe("T-0007");
  });

  it("excludes a ready card with an unmet dependency", () => {
    const picked = selectNextCard([
      makeTask({ id: "T-0001", priority: "P0", depends_on: ["T-0002"] }),
      makeTask({ id: "T-0002", status: "in-progress" }),
      makeTask({ id: "T-0003", priority: "P2" })
    ]);
    expect(picked.id).toBe("T-0003");
  });

  it("includes a ready card whose dependencies are all done or retired", () => {
    const picked = selectNextCard([
      makeTask({ id: "T-0001", priority: "P0", depends_on: ["T-0002", "T-0003"] }),
      makeTask({ id: "T-0002", status: "done" }),
      makeTask({ id: "T-0003", status: "retired" })
    ]);
    expect(picked.id).toBe("T-0001");
  });

  it("excludes a ready card whose dependency does not exist at all", () => {
    expect(selectNextCard([makeTask({ depends_on: ["T-9999"] })])).toBeNull();
  });

  it("excludes a ready card owned by the non-executable dispatch sentinel", () => {
    const picked = selectNextCard([
      makeTask({ id: "T-0001", priority: "P0", agent: "dispatch" }),
      makeTask({ id: "T-0002", priority: "P2" })
    ]);
    expect(picked.id).toBe("T-0002");
  });
});

describe("createAutoLaunchPoller — gate 1: enabled", () => {
  it("tick() is a no-op that reads nothing when disabled", async () => {
    const { poller, store, readUsage, launchFn } = makePoller({ enabled: false });
    expect(await poller.tick()).toBeNull();
    expect(readUsage).not.toHaveBeenCalled();
    expect(store.list).not.toHaveBeenCalled();
    expect(launchFn).not.toHaveBeenCalled();
    expect(poller.enabled).toBe(false);
  });

  it("tick() is a no-op when intervalMs is 0, even if enabled", async () => {
    const { poller, launchFn } = makePoller({ intervalMs: 0 });
    expect(await poller.tick()).toBeNull();
    expect(launchFn).not.toHaveBeenCalled();
    expect(poller.enabled).toBe(false);
  });

  it("launches when enabled and every gate passes", async () => {
    const { poller, launchFn, logger } = makePoller();
    const launched = await poller.tick();
    expect(launchFn).toHaveBeenCalledTimes(1);
    expect(launched.id).toBe("T-0001");
    expect(logLines(logger)).toMatch(/launched T-0001/);
  });
});

describe("createAutoLaunchPoller — gate 2: usage", () => {
  it("skips when the newest utilization is at or above the threshold", async () => {
    const { poller, orchestrator, launchFn, logger } = makePoller({
      usage: { utilization: 0.8, status: "allowed_warning", reason: "status=allowed_warning" }
    });
    expect(await poller.tick()).toBeNull();
    expect(orchestrator.hasActiveRuns).not.toHaveBeenCalled();
    expect(launchFn).not.toHaveBeenCalled();
    expect(logLines(logger)).toMatch(/usage/i);
  });

  it("skips when the newest telemetry is a rejection", async () => {
    const { poller, launchFn, logger } = makePoller({
      usage: { utilization: 1, status: "rejected", reason: "status=rejected" }
    });
    expect(await poller.tick()).toBeNull();
    expect(launchFn).not.toHaveBeenCalled();
    expect(logLines(logger)).toMatch(/rejected/);
  });

  it("skips when usage cannot be determined at all", async () => {
    const { poller, orchestrator, launchFn, logger } = makePoller({
      usage: { utilization: null, status: null, reason: "no rate-limit telemetry found" }
    });
    expect(await poller.tick()).toBeNull();
    expect(orchestrator.hasActiveRuns).not.toHaveBeenCalled();
    expect(launchFn).not.toHaveBeenCalled();
    expect(logLines(logger)).toMatch(/no rate-limit telemetry found/);
  });

  it("skips when the usage read itself throws -- an unreadable signal is never treated as low usage", async () => {
    const { poller, launchFn, logger } = makePoller({
      readUsage: vi.fn(async () => {
        throw new Error("EIO");
      })
    });
    expect(await poller.tick()).toBeNull();
    expect(launchFn).not.toHaveBeenCalled();
    expect(logLines(logger)).toMatch(/EIO/);
  });

  it("launches when utilization sits just below the configured threshold", async () => {
    const { poller, launchFn } = makePoller({
      usageMax: 0.95,
      usage: { utilization: 0.9, status: "allowed_warning", reason: "status=allowed_warning" }
    });
    expect(await poller.tick()).not.toBeNull();
    expect(launchFn).toHaveBeenCalledTimes(1);
  });
});

describe("createAutoLaunchPoller — gate 3: board idle", () => {
  it("skips when the orchestrator reports an active run", async () => {
    const { poller, store, launchFn, logger } = makePoller({ active: true });
    expect(await poller.tick()).toBeNull();
    expect(store.list).not.toHaveBeenCalled();
    expect(launchFn).not.toHaveBeenCalled();
    expect(logLines(logger)).toMatch(/active run/i);
  });

  it.each(["in-progress", "validation"])("skips when a card sits at %s even if the orchestrator looks idle", async (status) => {
    const { poller, launchFn, logger } = makePoller({
      tasks: [makeTask({ id: "T-0001" }), makeTask({ id: "T-0002", status })]
    });
    expect(await poller.tick()).toBeNull();
    expect(launchFn).not.toHaveBeenCalled();
    expect(logLines(logger)).toMatch(/T-0002/);
  });

  it("skips when the task list cannot be read", async () => {
    const { poller, store, launchFn, logger } = makePoller();
    store.list.mockRejectedValue(new Error("db locked"));
    expect(await poller.tick()).toBeNull();
    expect(launchFn).not.toHaveBeenCalled();
    expect(logLines(logger)).toMatch(/db locked/);
  });
});

describe("createAutoLaunchPoller — gate 4/5: eligibility and launch", () => {
  it("skips quietly when no card is eligible", async () => {
    const { poller, launchFn, logger } = makePoller({ tasks: [makeTask({ status: "backlog" })] });
    expect(await poller.tick()).toBeNull();
    expect(launchFn).not.toHaveBeenCalled();
    expect(logLines(logger)).toMatch(/no eligible/i);
  });

  it("launches exactly one card per tick even when several are eligible", async () => {
    const { poller, launchFn } = makePoller({
      tasks: [
        makeTask({ id: "T-0001", priority: "P1" }),
        makeTask({ id: "T-0002", priority: "P0" }),
        makeTask({ id: "T-0003", priority: "P0" })
      ]
    });
    await poller.tick();
    expect(launchFn).toHaveBeenCalledTimes(1);
    expect(launchFn).toHaveBeenCalledWith(expect.objectContaining({ id: "T-0002" }));
  });

  it("launches through the guarded path, passing the orchestrator so every Run-button guard applies", async () => {
    const { poller, launchFn, orchestrator } = makePoller();
    await poller.tick();
    expect(launchFn).toHaveBeenCalledWith(expect.objectContaining({ orchestrator, id: "T-0001" }));
  });

  it("T-0379: always launches with trigger 'auto' -- the poller has no config surface to pass anything else, so it can never reach the manual-override path", async () => {
    const { poller, launchFn } = makePoller();
    await poller.tick();
    expect(launchFn).toHaveBeenCalledWith(expect.objectContaining({ trigger: LAUNCH_TRIGGERS.AUTO }));
    expect(launchFn).not.toHaveBeenCalledWith(expect.objectContaining({ trigger: LAUNCH_TRIGGERS.MANUAL }));
  });

  it("does NOT start a card with an unmet dependency even if selection mistakenly offers it -- the guarded path refuses it", async () => {
    const runCard = vi.fn();
    const orchestrator = {
      hasActiveRuns: () => false,
      isRunning: () => false,
      runCard,
      hub: { broadcast: vi.fn() },
      store: {
        get: async (id) =>
          ({
            "T-0001": makeTask({ id: "T-0001", depends_on: ["T-0002"] }),
            "T-0002": makeTask({ id: "T-0002", status: "ready" })
          })[id] ?? null,
        update: vi.fn()
      }
    };
    const logger = makeLogger();
    const poller = createAutoLaunchPoller({
      store: {
        // A deliberately broken selector stand-in: the corpus the poller lists claims the
        // dependency is done, so selection offers T-0001; the real store the guard reads says
        // otherwise. Only the guard can catch this, which is exactly what is under test.
        list: async () => [makeTask({ id: "T-0001", depends_on: ["T-0002"] }), makeTask({ id: "T-0002", status: "done" })]
      },
      orchestrator,
      runsDir: "/runs",
      enabled: true,
      intervalMs: 1000,
      usageMax: 0.8,
      readUsage: async () => ({ utilization: 0, status: "allowed", reason: "status=allowed" }),
      logger
    });

    expect(await poller.tick()).toBeNull();
    expect(runCard).not.toHaveBeenCalled();
    expect(logger.log.mock.calls.map((c) => c[0]).join("\n")).toMatch(/unmet dependencies/i);
  });

  it("reports a refused launch as a skip and does not fall through to the next candidate", async () => {
    const launchFn = vi.fn(async () => {
      throw new CardLaunchError("Task T-0001 already has an active run", 409);
    });
    const { poller, logger } = makePoller({
      tasks: [makeTask({ id: "T-0001", priority: "P0" }), makeTask({ id: "T-0002", priority: "P1" })],
      launchFn
    });
    expect(await poller.tick()).toBeNull();
    expect(launchFn).toHaveBeenCalledTimes(1);
    expect(logLines(logger)).toMatch(/already has an active run/);
  });

  describe("T-0379: queue behaviour -- a capacity-fit hold on the head of the queue tries the next eligible card", () => {
    function capacityFitError(id, reason = "five_hour: units_not_comparable") {
      const err = new CardLaunchError(`Cannot run ${id}: WIP gate hold (enforcement) -- ${reason}`, 409);
      err.capacityFitHold = true;
      return err;
    }

    it("falls through past a non-fitting head-of-queue card to a smaller fitting one behind it, and logs the pass-over", async () => {
      const launchFn = vi.fn(async ({ id }) => {
        if (id === "T-0001") throw capacityFitError("T-0001");
        return makeTask({ id });
      });
      const { poller, logger } = makePoller({
        tasks: [makeTask({ id: "T-0001", priority: "P0" }), makeTask({ id: "T-0002", priority: "P1" })],
        launchFn
      });

      const launched = await poller.tick();
      expect(launchFn).toHaveBeenCalledTimes(2);
      expect(launchFn.mock.calls[0][0]).toMatchObject({ id: "T-0001", trigger: LAUNCH_TRIGGERS.AUTO });
      expect(launchFn.mock.calls[1][0]).toMatchObject({ id: "T-0002", trigger: LAUNCH_TRIGGERS.AUTO });
      expect(launched.id).toBe("T-0002");
      expect(logLines(logger)).toMatch(/T-0001.*does not fit/is);
      expect(logLines(logger)).toMatch(/units_not_comparable/);
    });

    it("does not fall through for a refusal that is NOT a capacity-fit hold, even alongside a fitting card behind it", async () => {
      const launchFn = vi.fn(async ({ id }) => {
        if (id === "T-0001") throw new CardLaunchError("Task T-0001 already has an active run", 409);
        return makeTask({ id });
      });
      const { poller, logger } = makePoller({
        tasks: [makeTask({ id: "T-0001", priority: "P0" }), makeTask({ id: "T-0002", priority: "P1" })],
        launchFn
      });
      expect(await poller.tick()).toBeNull();
      expect(launchFn).toHaveBeenCalledTimes(1);
      expect(logLines(logger)).toMatch(/already has an active run/);
    });

    it("exhausts every candidate and skips the tick, logging each one's hold reason, when none fit", async () => {
      const launchFn = vi.fn(async ({ id }) => {
        throw capacityFitError(id, id === "T-0001" ? "five_hour: units_not_comparable" : "seven_day: no_measured_window_reading");
      });
      const { poller, logger } = makePoller({
        tasks: [makeTask({ id: "T-0001", priority: "P0" }), makeTask({ id: "T-0002", priority: "P1" })],
        launchFn
      });
      expect(await poller.tick()).toBeNull();
      expect(launchFn).toHaveBeenCalledTimes(2);
      expect(logLines(logger)).toMatch(/T-0001/);
      expect(logLines(logger)).toMatch(/T-0002/);
      expect(logLines(logger)).toMatch(/units_not_comparable/);
      expect(logLines(logger)).toMatch(/no_measured_window_reading/);
    });

    it("names a permanently oversized estimate's own reason when passing over it", async () => {
      const launchFn = vi.fn(async ({ id }) => {
        if (id === "T-0001") throw capacityFitError("T-0001", "five_hour: oversized_estimate_never_fits -- never fits this window even at full headroom; launch manually or split the card");
        return makeTask({ id });
      });
      const { poller, logger } = makePoller({
        tasks: [makeTask({ id: "T-0001", priority: "P0" }), makeTask({ id: "T-0002", priority: "P1" })],
        launchFn
      });
      const launched = await poller.tick();
      expect(launched.id).toBe("T-0002");
      expect(logLines(logger)).toMatch(/oversized_estimate_never_fits/);
      expect(logLines(logger)).toMatch(/launch manually or split/);
    });
  });
});

describe("createAutoLaunchPoller — start/stop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ticks on the configured interval once started", async () => {
    const { poller, launchFn } = makePoller();
    poller.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(launchFn).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("does not tick again after stop", async () => {
    const { poller, launchFn } = makePoller();
    poller.start();
    poller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(launchFn).not.toHaveBeenCalled();
  });

  it("never starts the interval when disabled", async () => {
    const { poller, readUsage } = makePoller({ enabled: false });
    poller.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readUsage).not.toHaveBeenCalled();
  });

  it("a failing tick is caught and logged, and the interval survives", async () => {
    const logger = makeLogger();
    const { poller, launchFn } = makePoller({
      logger,
      launchFn: vi.fn(async () => {
        throw new Error("unexpected");
      })
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(logger.error).toHaveBeenCalled();
    expect(launchFn).toHaveBeenCalledTimes(2);
    poller.stop();
  });
});

describe("usage gate: genuinely-absent telemetry must not stall the poller forever", () => {
  const ABSENT = {
    utilization: null,
    status: null,
    logPath: null,
    telemetryAbsent: true,
    reason: "no rate-limit telemetry found in /runs/*.jsonl"
  };
  const UNREADABLE = {
    utilization: null,
    status: "who-knows",
    logPath: "/runs/x.jsonl",
    telemetryAbsent: false,
    reason: 'unrecognized rate-limit status "who-knows"'
  };

  it("PROCEEDS with a warning when telemetry is genuinely absent", async () => {
    // 2026-09-04: the usage gate sits AHEAD of the idle gate, and an undetermined reading skipped.
    // With telemetry unfindable the poller skipped every 30 minutes indefinitely while ready cards
    // sat idle -- absence of evidence read as evidence of saturation. The usage-max guard cannot
    // function without data at all, so blocking forever on no data protects nothing, while the
    // idle gate and the launch guard still prevent a double-launch.
    const { poller, launchFn, logger } = makePoller({ usage: ABSENT });

    const launched = await poller.tick();

    expect(launchFn).toHaveBeenCalledOnce();
    expect(launched).not.toBeNull();
    const lines = [...logger.log.mock.calls, ...logger.warn.mock.calls].map((c) => c.join(" "));
    expect(lines.some((l) => /telemetry/i.test(l) && /proceed/i.test(l))).toBe(true);
  });

  it("still SKIPS when telemetry exists but is unrecognized -- bad data still fails closed", async () => {
    const { poller, launchFn } = makePoller({ usage: UNREADABLE });

    expect(await poller.tick()).toBeNull();
    expect(launchFn).not.toHaveBeenCalled();
  });

  it("still SKIPS when the telemetry read itself errored", async () => {
    const { poller, launchFn } = makePoller({
      usage: {
        utilization: null, status: null, logPath: null,
        telemetryAbsent: false, reason: "rate-limit telemetry unreadable: EIO"
      }
    });

    expect(await poller.tick()).toBeNull();
    expect(launchFn).not.toHaveBeenCalled();
  });

  it("absent telemetry does NOT bypass the idle gate", async () => {
    const { poller, launchFn } = makePoller({ usage: ABSENT, active: true });

    expect(await poller.tick()).toBeNull();
    expect(launchFn).not.toHaveBeenCalled();
  });

  it("absent telemetry does NOT bypass the eligible-card gate", async () => {
    const { poller, launchFn } = makePoller({ usage: ABSENT, tasks: [] });

    expect(await poller.tick()).toBeNull();
    expect(launchFn).not.toHaveBeenCalled();
  });

  it("a saturated reading still blocks, unchanged", async () => {
    const { poller, launchFn } = makePoller({
      usage: {
        utilization: 1, status: "rejected", logPath: "/runs/x.jsonl",
        telemetryAbsent: false, reason: "status=rejected utilization=1"
      }
    });

    expect(await poller.tick()).toBeNull();
    expect(launchFn).not.toHaveBeenCalled();
  });

  it("treats a missing telemetryAbsent field as NOT absent, so an old snapshot shape fails closed", async () => {
    const { poller, launchFn } = makePoller({
      usage: { utilization: null, status: null, logPath: null, reason: "legacy shape" }
    });

    expect(await poller.tick()).toBeNull();
    expect(launchFn).not.toHaveBeenCalled();
  });
});

describe("usage gate surfaces WHEN the limit resets, not just that it is blocked", () => {
  const RESETS_MS = 1_788_000_000_000 + 42 * 60 * 1000; // 42 minutes out

  it("names the reset instant and the wait in the skip line", async () => {
    // Dennie's ask: skipping should say when it can resume, not just that it is blocked.
    const { poller, logger } = makePoller({
      usage: {
        utilization: 1,
        status: "rejected",
        logPath: "/runs/x.jsonl",
        telemetryAbsent: false,
        rateLimitType: "five_hour",
        resetsAtMs: RESETS_MS,
        resetsAtIso: new Date(RESETS_MS).toISOString(),
        msUntilReset: 42 * 60 * 1000,
        resetElapsed: false,
        reason: "status=rejected utilization=1"
      },
      now: () => 1_788_000_000_000
    });

    expect(await poller.tick()).toBeNull();

    const line = logLines(logger);
    expect(line).toMatch(/resets/i);
    expect(line).toContain(new Date(RESETS_MS).toISOString());
    expect(line).toMatch(/42m|42 min/i);
    expect(line).toMatch(/five_hour/);
  });

  it("still logs a usable skip line when the payload carries no reset instant", async () => {
    const { poller, logger } = makePoller({
      usage: {
        utilization: 1, status: "rejected", logPath: "/runs/x.jsonl", telemetryAbsent: false,
        rateLimitType: null, resetsAtMs: null, resetsAtIso: null, msUntilReset: null,
        resetElapsed: false, reason: "status=rejected utilization=1"
      }
    });

    expect(await poller.tick()).toBeNull();

    const line = logLines(logger);
    expect(line).toMatch(/usage 1 >= max/);
    expect(line).toMatch(/reset time unknown/i);
  });

  it("does not claim a reset time when it is not blocked on usage", async () => {
    const { poller, launchFn, logger } = makePoller({
      usage: {
        utilization: 0, status: "allowed", logPath: "/runs/x.jsonl", telemetryAbsent: false,
        rateLimitType: "five_hour", resetsAtMs: RESETS_MS,
        resetsAtIso: new Date(RESETS_MS).toISOString(), msUntilReset: 1, resetElapsed: false,
        reason: "status=allowed utilization=0"
      }
    });

    await poller.tick();

    expect(launchFn).toHaveBeenCalledOnce();
    expect(logLines(logger)).not.toMatch(/resets at/i);
  });
});

function telemetryReading(overrides = {}) {
  return { windowKind: "five_hour", classification: READING_STATUS.MEASURED, utilization: 0.1, resetElapsed: false, ...overrides };
}

describe("evaluateWindowAwareUsageGate", () => {
  it("blocks a window whose measured utilization is at or above usageMax", () => {
    const result = evaluateWindowAwareUsageGate({
      telemetryReadings: {
        five_hour: telemetryReading({ windowKind: "five_hour", utilization: 0.9 }),
        seven_day: telemetryReading({ windowKind: "seven_day", utilization: 0.1 })
      },
      usageMax: 0.8
    });
    expect(result.blocked).toBe(true);
    expect(result.blockedWindows).toEqual(["five_hour"]);
    expect(result.windows.seven_day.blocked).toBe(false);
  });

  it("never blocks on an unmeasured window -- unknown stays unknown, not a fabricated block", () => {
    const result = evaluateWindowAwareUsageGate({
      telemetryReadings: {
        five_hour: telemetryReading({ windowKind: "five_hour", classification: READING_STATUS.STALE, utilization: null }),
        seven_day: telemetryReading({ windowKind: "seven_day", utilization: 0.1 })
      },
      usageMax: 0.8
    });
    expect(result.windows.five_hour.blocked).toBeNull();
    expect(result.blocked).toBe(false);
  });

  it("is healthy when every measured window sits below usageMax", () => {
    const result = evaluateWindowAwareUsageGate({
      telemetryReadings: {
        five_hour: telemetryReading({ windowKind: "five_hour", utilization: 0.1 }),
        seven_day: telemetryReading({ windowKind: "seven_day", utilization: 0.2 })
      },
      usageMax: 0.8
    });
    expect(result.blocked).toBe(false);
    expect(result.blockedWindows).toEqual([]);
  });
});

describe("createAutoLaunchPoller — window-aware usage comparison (WIP gate T-D, launch-time contracts)", () => {
  function makeTelemetryPoller({
    telemetryReadings = {
      five_hour: telemetryReading({ windowKind: "five_hour", utilization: 0.1 }),
      seven_day: telemetryReading({ windowKind: "seven_day", utilization: 0.1 })
    },
    readUsageTelemetryFn = vi.fn(async () => telemetryReadings),
    enforcementEnabled = false,
    ...overrides
  } = {}) {
    return { ...makePoller({ readUsageTelemetryFn, enforcementEnabled, ...overrides }), readUsageTelemetryFn };
  }

  it("with the default (advisory) configuration, logs the window-aware decision alongside the legacy one but still launches on the legacy decision alone", async () => {
    const { poller, launchFn, logger } = makeTelemetryPoller({
      usage: { utilization: 0.1, status: "allowed", logPath: "/runs/x.jsonl", reason: "status=allowed utilization=0.1" },
      telemetryReadings: {
        five_hour: telemetryReading({ windowKind: "five_hour", utilization: 0.95 }), // window-aware WOULD block
        seven_day: telemetryReading({ windowKind: "seven_day", utilization: 0.1 })
      }
    });

    await poller.tick();

    expect(launchFn).toHaveBeenCalledOnce();
    expect(logLines(logger)).toMatch(/usage gate comparison/);
    expect(logLines(logger)).toMatch(/window-aware/);
  });

  it("under the enforcement flag, the window-aware decision replaces the legacy gate and blocks a launch the legacy gate alone would have allowed", async () => {
    const { poller, launchFn, logger } = makeTelemetryPoller({
      enforcementEnabled: true,
      usage: { utilization: 0.1, status: "allowed", logPath: "/runs/x.jsonl", reason: "status=allowed utilization=0.1" },
      telemetryReadings: {
        five_hour: telemetryReading({ windowKind: "five_hour", utilization: 0.95 }),
        seven_day: telemetryReading({ windowKind: "seven_day", utilization: 0.1 })
      }
    });

    await poller.tick();

    expect(launchFn).not.toHaveBeenCalled();
    expect(logLines(logger)).toMatch(/window-aware usage gate blocked/i);
  });

  it("under the enforcement flag, a healthy window-aware reading launches even though this card never enables the flag on the live board", async () => {
    const { poller, launchFn } = makeTelemetryPoller({
      enforcementEnabled: true,
      usage: { utilization: 0.1, status: "allowed", logPath: "/runs/x.jsonl", reason: "status=allowed utilization=0.1" },
      telemetryReadings: {
        five_hour: telemetryReading({ windowKind: "five_hour", utilization: 0.1 }),
        seven_day: telemetryReading({ windowKind: "seven_day", utilization: 0.1 })
      }
    });

    await poller.tick();
    expect(launchFn).toHaveBeenCalledOnce();
  });

  it("defaults to enforcement OFF (admissionEnforcementEnabledFromEnv), so a fresh poller with no override never blocks on window-aware evidence alone", async () => {
    const { poller, launchFn } = makePoller({
      readUsageTelemetryFn: vi.fn(async () => ({
        five_hour: telemetryReading({ windowKind: "five_hour", utilization: 0.99 }),
        seven_day: telemetryReading({ windowKind: "seven_day", utilization: 0.99 })
      })),
      usage: { utilization: 0.1, status: "allowed", logPath: "/runs/x.jsonl", reason: "status=allowed utilization=0.1" }
    });
    await poller.tick();
    expect(launchFn).toHaveBeenCalledOnce();
  });

  it("is failure-isolated: a throwing window-aware telemetry reader never affects the legacy gate's own decision", async () => {
    const { poller, launchFn, logger } = makeTelemetryPoller({
      readUsageTelemetryFn: vi.fn(async () => {
        throw new Error("telemetry unreadable");
      }),
      usage: { utilization: 0.1, status: "allowed", logPath: "/runs/x.jsonl", reason: "status=allowed utilization=0.1" }
    });

    await poller.tick();

    expect(launchFn).toHaveBeenCalledOnce();
    expect(logLines(logger)).toMatch(/window-aware usage comparison unavailable/);
  });

  it("T-0370 (Codex finding 3): a never-settling readUsageTelemetryFn cannot hang a tick -- the launch still happens once the bound elapses", async () => {
    vi.useFakeTimers();
    try {
      const { poller, launchFn } = makeTelemetryPoller({
        readUsageTelemetryFn: vi.fn(() => new Promise(() => {})),
        usage: { utilization: 0.1, status: "allowed", logPath: "/runs/x.jsonl", reason: "status=allowed utilization=0.1" }
      });

      const tickPromise = poller.tick();
      await vi.advanceTimersByTimeAsync(10_000);
      await tickPromise;

      expect(launchFn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * T-0383: `getStatus()` is what `GET /api/poller` reports -- it must never read the repo or a
 * unit file, only what the poller already tracks in memory. These tests pin the shape and the
 * bookkeeping (`lastTickAt`/`lastResult`/`nextTickAt`) that every tick updates.
 */
describe("createAutoLaunchPoller — getStatus()", () => {
  it("reports enabled/intervalMs/usageMax from construction before any tick has run", () => {
    const { poller } = makePoller({ intervalMs: 12_345, usageMax: 0.42 });
    const status = poller.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.intervalMs).toBe(12_345);
    expect(status.usageMax).toBe(0.42);
    expect(status.lastTickAt).toBeNull();
    expect(status.lastResult).toBeNull();
  });

  it("reports enabled: false when AUTO_LAUNCH_ENABLED is off, without touching the store", () => {
    const { poller, store } = makePoller({ enabled: false });
    const status = poller.getStatus();
    expect(status.enabled).toBe(false);
    expect(store.list).not.toHaveBeenCalled();
  });

  it("records lastTickAt and a skip reason after a tick that skips", async () => {
    const { poller } = makePoller({
      now: () => 1_700_000_000_000,
      usage: { utilization: 0.9, status: "allowed_warning", reason: "status=allowed_warning" }
    });
    await poller.tick();
    const status = poller.getStatus();
    expect(status.lastTickAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(status.lastResult).toMatchObject({ kind: "skip" });
    expect(status.lastResult.reason).toMatch(/usage/i);
  });

  it("records lastTickAt and the launched card id after a tick that launches", async () => {
    const { poller } = makePoller({ now: () => 1_700_000_000_000 });
    await poller.tick();
    const status = poller.getStatus();
    expect(status.lastTickAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(status.lastResult).toMatchObject({ kind: "launched", cardId: "T-0001" });
  });

  it("computes nextTickAt as lastTickAt + intervalMs once a tick has run", async () => {
    const { poller } = makePoller({ now: () => 1_700_000_000_000, intervalMs: 60_000 });
    await poller.tick();
    const status = poller.getStatus();
    expect(status.nextTickAt).toBe(new Date(1_700_000_060_000).toISOString());
  });

  it("reports activeRun from the orchestrator's own hasActiveRuns()", () => {
    const { poller, orchestrator } = makePoller({ active: true });
    expect(poller.getStatus().activeRun).toBe(true);
    expect(orchestrator.hasActiveRuns).toHaveBeenCalled();
  });

  it("reports running: true once start() has been called, false before/after stop()", () => {
    const { poller } = makePoller({ intervalMs: 60_000 });
    expect(poller.getStatus().running).toBe(false);
    poller.start();
    expect(poller.getStatus().running).toBe(true);
    poller.stop();
    expect(poller.getStatus().running).toBe(false);
  });

  it("records an error result (and still rethrows) when launchFn throws something other than CardLaunchError", async () => {
    const boom = new Error("unexpected failure");
    const { poller } = makePoller({
      now: () => 1_700_000_000_000,
      launchFn: vi.fn(async () => {
        throw boom;
      })
    });

    await expect(poller.tick()).rejects.toThrow(boom);

    const status = poller.getStatus();
    // lastTickAt is set unconditionally near the top of tick(), before the launch attempt --
    // lastResult must be refreshed in step with it, never left describing an earlier tick.
    expect(status.lastTickAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(status.lastResult).toMatchObject({ kind: "error", cardId: "T-0001" });
    expect(status.lastResult.reason).toMatch(/unexpected failure/);
  });
});

describe("orderCandidatesWithAging -- waiting cards age so ordinary work is not starved", () => {
  const now = Date.parse("2026-09-20T00:00:00.000Z");

  it("leaves order unchanged when nobody has any wait history", () => {
    const tracker = createDrainWaitTracker();
    const candidates = [makeTask({ id: "T-0001", priority: "P1" }), makeTask({ id: "T-0002", priority: "P1" })];
    const ordered = orderCandidatesWithAging(candidates, { drainTracker: tracker, now });
    expect(ordered.map((t) => t.id)).toEqual(["T-0001", "T-0002"]);
  });

  it("moves a long-waiting card ahead of a same-priority newer one that would otherwise win on id order alone", () => {
    const tracker = createDrainWaitTracker();
    tracker.recordHeld("T-0005", now - 5 * DEFAULT_DRAIN_CONFIG.agingStepMs);
    const candidates = [makeTask({ id: "T-0001", priority: "P1" }), makeTask({ id: "T-0005", priority: "P1" })];
    const ordered = orderCandidatesWithAging(candidates, { drainTracker: tracker, now });
    expect(ordered.map((t) => t.id)).toEqual(["T-0005", "T-0001"]);
  });

  it("never lets aging cross a real priority boundary -- a fresh P0 card still goes before an aged P1 one", () => {
    const tracker = createDrainWaitTracker();
    tracker.recordHeld("T-0005", now - 50 * DEFAULT_DRAIN_CONFIG.agingStepMs);
    const candidates = [makeTask({ id: "T-0005", priority: "P1" }), makeTask({ id: "T-0001", priority: "P0" })];
    const ordered = orderCandidatesWithAging(candidates, { drainTracker: tracker, now });
    expect(ordered.map((t) => t.id)).toEqual(["T-0001", "T-0005"]);
  });

  it("falls back to numeric id order among same-priority cards with equal aging", () => {
    const tracker = createDrainWaitTracker();
    const candidates = [makeTask({ id: "T-0010", priority: "P2" }), makeTask({ id: "T-0002", priority: "P2" })];
    const ordered = orderCandidatesWithAging(candidates, { drainTracker: tracker, now });
    expect(ordered.map((t) => t.id)).toEqual(["T-0002", "T-0010"]);
  });
});

describe("createAutoLaunchPoller -- WIP gate T-F drain mode integration", () => {
  function capacityFitHoldError(message, extra = {}) {
    const err = new CardLaunchError(message, 409);
    err.capacityFitHold = true;
    Object.assign(err, extra);
    return err;
  }

  it("drain mode off (default): getStatus().drain is always empty, even when every candidate is held -- zero footprint on today's behaviour", async () => {
    const task = makeTask({ id: "T-0001" });
    const { poller } = makePoller({
      tasks: [task],
      now: () => 1_700_000_000_000,
      launchFn: vi.fn(async () => {
        throw capacityFitHoldError("does not fit", {
          admission: { admitted: false, windows: { five_hour: { windowKind: "five_hour", admitted: false, holdReason: "insufficient_capacity" } } },
          telemetryReadings: { five_hour: { resetsAtMs: 1_700_100_000_000, resetElapsed: false } }
        });
      })
    });

    expect(await poller.tick()).toBeNull();
    expect(poller.getStatus().drain).toEqual({});
  });

  it("drain mode on: an ordinary capacity hold is tracked and reported, naming the blocking window and its OWN reset -- never the other window's", async () => {
    const task = makeTask({ id: "T-0001" });
    const fiveHourResetMs = 1_700_010_000_000; // soon
    const sevenDayResetMs = 1_700_500_000_000; // far later -- the real horizon
    const { poller } = makePoller({
      tasks: [task],
      now: () => 1_700_000_000_000,
      drainModeEnabled: true,
      launchFn: vi.fn(async () => {
        throw capacityFitHoldError("does not fit", {
          admission: {
            admitted: false,
            windows: {
              five_hour: { windowKind: "five_hour", admitted: true, holdReason: null },
              seven_day: { windowKind: "seven_day", admitted: false, holdReason: "insufficient_capacity" }
            }
          },
          telemetryReadings: {
            five_hour: { resetsAtMs: fiveHourResetMs, resetElapsed: false },
            seven_day: { resetsAtMs: sevenDayResetMs, resetElapsed: false }
          }
        });
      })
    });

    expect(await poller.tick()).toBeNull();
    const drain = poller.getStatus().drain;
    expect(drain["T-0001"]).toMatchObject({ status: "waiting", blockingWindow: "seven_day", nextReconsiderationAtMs: sevenDayResetMs });
  });

  it("drain mode on: an oversized hold is no longer tracked as ORDINARY waiting work -- distinct from a same-tick ordinary hold that IS still reconsidered -- but it stays visible as a terminal hold (FIX ROUND 2 finding 2: 'oversized holds behave the same way' as a wait-expired hold)", async () => {
    const oversizedTask = makeTask({ id: "T-0001", priority: "P1" });
    const ordinaryTask = makeTask({ id: "T-0002", priority: "P1" });
    const launchFn = vi.fn(async ({ id }) => {
      if (id === "T-0001") {
        throw capacityFitHoldError("oversized", { drainHeldOversized: true, blockingWindow: "seven_day", reason: "Oversized for the seven_day window -- split or re-scope." });
      }
      throw capacityFitHoldError("does not fit", {
        admission: { admitted: false, windows: { five_hour: { windowKind: "five_hour", admitted: false, holdReason: "insufficient_capacity" } } },
        telemetryReadings: { five_hour: { resetsAtMs: 1_700_100_000_000, resetElapsed: false } }
      });
    });
    const { poller } = makePoller({ tasks: [oversizedTask, ordinaryTask], now: () => 1_700_000_000_000, drainModeEnabled: true, launchFn });

    expect(await poller.tick()).toBeNull();
    const drain = poller.getStatus().drain;
    // No longer ordinary wait bookkeeping (no firstHeldAtMs/timesPassedOver aging entry) --
    // but the terminal hold itself is still reported, not dropped from the map entirely.
    expect(drain["T-0001"]).toMatchObject({ status: DRAIN_STATUS.HELD_OVERSIZED, blockingWindow: "seven_day" });
    expect(drain["T-0002"]).toMatchObject({ status: "waiting", blockingWindow: "five_hour" });
    expect(launchFn).toHaveBeenCalledWith(expect.objectContaining({ id: "T-0001" }));
    expect(launchFn).toHaveBeenCalledWith(expect.objectContaining({ id: "T-0002" }));
  });

  it("drain mode on: a still-waiting card's aging boost grows tick over tick, and it keeps being reconsidered rather than dropped", async () => {
    const task = makeTask({ id: "T-0001" });
    let nowMs = 1_700_000_000_000;
    const launchFn = vi.fn(async () => {
      throw capacityFitHoldError("does not fit", {
        admission: { admitted: false, windows: { five_hour: { windowKind: "five_hour", admitted: false, holdReason: "insufficient_capacity" } } },
        telemetryReadings: { five_hour: { resetsAtMs: null, resetElapsed: false } }
      });
    });
    const { poller } = makePoller({ tasks: [task], now: () => nowMs, drainModeEnabled: true, launchFn });

    expect(await poller.tick()).toBeNull();
    expect(poller.getStatus().drain["T-0001"].agingBoost).toBe(0);

    nowMs += 4 * DEFAULT_DRAIN_CONFIG.agingStepMs;
    expect(await poller.tick()).toBeNull();
    expect(poller.getStatus().drain["T-0001"].agingBoost).toBe(4);
    expect(launchFn).toHaveBeenCalledTimes(2);
  });

  // FIX ROUND 1 finding (a): "Past maxWaitMs, evaluateDrainState no longer returns waiting with a
  // capped timestamp and overdue: true that nothing acts on. It transitions to a distinct terminal
  // state... The consumer acts on it: autoLaunchPoller.js handles the terminal state distinctly
  // from waiting -- it stops re-reporting the card as merely waiting and surfaces the hold." Drives
  // repeated ticks ACROSS the deadline (Chat's own reproduction shape), not just one evaluation.
  it("REGRESSION (FIX ROUND 1a): repeated ticks across the deadline transition the card to a terminal hold -- blocked for a human, never launched, and no longer reported as merely waiting", async () => {
    const task = makeTask({ id: "T-0001" });
    let nowMs = 1000;
    const drainConfig = { ...DEFAULT_DRAIN_CONFIG, maxWaitMs: 1000 };
    const launchFn = vi.fn(async () => {
      throw capacityFitHoldError("does not fit", {
        admission: { admitted: false, windows: { five_hour: { windowKind: "five_hour", admitted: false, holdReason: "insufficient_capacity" } } },
        telemetryReadings: { five_hour: { resetsAtMs: null, resetElapsed: false } }
      });
    });
    const { poller, store, orchestrator, logger } = makePoller({
      tasks: [task],
      now: () => nowMs,
      drainModeEnabled: true,
      drainConfig,
      launchFn
    });

    // Tick 1 (now=1000): first hold -- ordinary WAITING.
    expect(await poller.tick()).toBeNull();
    expect(poller.getStatus().drain["T-0001"]).toMatchObject({ status: DRAIN_STATUS.WAITING });
    expect(store.update).not.toHaveBeenCalled();

    // Tick 2 (now=10000): well past firstHeldAtMs(1000) + maxWaitMs(1000) = 2000.
    nowMs = 10000;
    expect(await poller.tick()).toBeNull();

    // Never launched despite "leaving drain" -- the terminal hold is never a free pass around
    // capacity admission. launchFn was tried (still refused by admission) but never returned a
    // launch outcome.
    expect(launchFn).toHaveBeenCalledTimes(2);

    // The card is blocked for a human, exactly like the oversized exit -- not left waiting.
    expect(store.update).toHaveBeenCalledWith(
      "T-0001",
      expect.objectContaining({ status: "blocked", body: expect.stringMatching(/wait|expired|human|intervention/i) })
    );
    expect(orchestrator.hub.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "changed", id: "T-0001" })
    );

    // No longer tracked as ORDINARY waiting work (distinct status, and the drainTracker's own
    // aging bookkeeping is gone) -- but FIX ROUND 2 finding 2 requires the terminal hold ITSELF
    // to stay visible in getStatus().drain until a human resolves it, not disappear the instant
    // it fires. A waiting badge must turn into a hold, never vanish.
    expect(poller.getStatus().drain["T-0001"]).toMatchObject({ status: DRAIN_STATUS.HELD_WAIT_EXPIRED, blockingWindow: "five_hour" });

    // The consumer's own log line is distinct from an ordinary "waiting" report.
    const lines = logLines(logger);
    expect(lines).toMatch(/held_wait_expired/);
  });

  // FIX ROUND 2 finding 2 (Chat round-3 review of #408): "The terminal hold is deleted before
  // anyone can see it... getStatus().drain is {} after the tick... The round-2 UI tests injected
  // terminal states directly, which is exactly why they passed over this." This drives the REAL
  // poller through REAL ticks (never an injected drain map) and probes exactly what Chat probed:
  // the card's real status alongside the real getStatus().drain payload.
  it("REGRESSION (FIX ROUND 2, finding 2): after the real poller records held_wait_expired, task.status is blocked AND getStatus().drain still describes the hold -- not {}", async () => {
    const task = makeTask({ id: "T-0001" });
    let nowMs = 1000;
    const drainConfig = { ...DEFAULT_DRAIN_CONFIG, maxWaitMs: 1000 };
    const launchFn = vi.fn(async () => {
      throw capacityFitHoldError("does not fit", {
        admission: { admitted: false, windows: { five_hour: { windowKind: "five_hour", admitted: false, holdReason: "insufficient_capacity" } } },
        telemetryReadings: { five_hour: { resetsAtMs: null, resetElapsed: false } }
      });
    });
    const { poller, store } = makePoller({ tasks: [task], now: () => nowMs, drainModeEnabled: true, drainConfig, launchFn });

    await poller.tick();
    nowMs = 10000;
    await poller.tick();

    const stored = await store.get("T-0001");
    const drain = poller.getStatus().drain;
    // The exact producer/consumer mismatch Chat's probe found: task.status === "blocked" while
    // getStatus().drain was {}. Both sides of the payload must now agree.
    expect(stored.status).toBe("blocked");
    expect(drain).not.toEqual({});
    expect(drain["T-0001"]).toMatchObject({ status: DRAIN_STATUS.HELD_WAIT_EXPIRED });
  });

  it("REGRESSION (FIX ROUND 2, finding 2): the terminal hold clears once a human moves the card back to an eligible state and it launches cleanly -- resolution, not a timeout", async () => {
    const task = makeTask({ id: "T-0001" });
    let nowMs = 1000;
    let shouldFit = false;
    const drainConfig = { ...DEFAULT_DRAIN_CONFIG, maxWaitMs: 1000 };
    const launchFn = vi.fn(async ({ id }) => {
      if (shouldFit) return makeTask({ id });
      throw capacityFitHoldError("does not fit", {
        admission: { admitted: false, windows: { five_hour: { windowKind: "five_hour", admitted: false, holdReason: "insufficient_capacity" } } },
        telemetryReadings: { five_hour: { resetsAtMs: null, resetElapsed: false } }
      });
    });
    const { poller, store } = makePoller({ tasks: [task], now: () => nowMs, drainModeEnabled: true, drainConfig, launchFn });

    await poller.tick();
    nowMs = 10000;
    await poller.tick();
    expect(poller.getStatus().drain["T-0001"]).toMatchObject({ status: DRAIN_STATUS.HELD_WAIT_EXPIRED });

    // A human re-scopes the card, moves it back to ready, and this time it fits -- the underlying
    // hold is genuinely resolved, not merely timed out.
    await store.update("T-0001", { status: "ready" });
    shouldFit = true;
    nowMs = 20000;
    await poller.tick();

    expect(poller.getStatus().drain).not.toHaveProperty("T-0001");
  });

  it("REGRESSION (FIX ROUND 1a): once blocked, the card is no longer an eligible candidate on the NEXT tick -- store.list() naturally excludes it", async () => {
    const task = makeTask({ id: "T-0001" });
    let nowMs = 1000;
    const drainConfig = { ...DEFAULT_DRAIN_CONFIG, maxWaitMs: 1000 };
    const launchFn = vi.fn(async () => {
      throw capacityFitHoldError("does not fit", {
        admission: { admitted: false, windows: { five_hour: { windowKind: "five_hour", admitted: false, holdReason: "insufficient_capacity" } } },
        telemetryReadings: { five_hour: { resetsAtMs: null, resetElapsed: false } }
      });
    });
    const { poller, store } = makePoller({ tasks: [task], now: () => nowMs, drainModeEnabled: true, drainConfig, launchFn });

    await poller.tick();
    nowMs = 10000;
    await poller.tick();
    await expect(store.get("T-0001")).resolves.toMatchObject({ status: "blocked" });

    nowMs = 20000;
    expect(await poller.tick()).toBeNull();
    expect(poller.getStatus().lastResult).toMatchObject({ kind: "skip" });
    expect(launchFn).toHaveBeenCalledTimes(2); // not called a third time -- T-0001 is no longer eligible
  });

  // FIX ROUND 2 finding 1 (Chat round-3 review of #408): "A finished wait leaves its deadline on
  // disk... If the card comes back to ready for another attempt after a restart, its first
  // capacity hold inherits the OLD attempt's deadline and can be held_wait_expired immediately."
  // Chat's own reproduction, driven through REAL poller ticks and REAL sidecar files under a real
  // tmp runsDir -- no real worker is ever launched (launchFn stays a fake).
  describe("REGRESSION (FIX ROUND 2, finding 1): a finished wait's deadline never survives on disk into the next attempt", () => {
    let runsDir;

    beforeEach(async () => {
      runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-autolaunch-drain-"));
    });

    afterEach(async () => {
      await fs.rm(runsDir, { recursive: true, force: true });
    });

    it("Chat's fixture: hold at 1000ms, successful (fake) launch at 1500ms, reload at 10000ms with maxWaitMs 1000ms -- the card's next hold starts a FRESH deadline, never held_wait_expired immediately", async () => {
      let nowMs = 1000;
      let shouldFit = false;
      const drainConfig = { ...DEFAULT_DRAIN_CONFIG, maxWaitMs: 1000 };
      const launchFn = vi.fn(async ({ id }) => {
        if (shouldFit) return makeTask({ id });
        throw capacityFitHoldError("does not fit", {
          admission: { admitted: false, windows: { five_hour: { windowKind: "five_hour", admitted: false, holdReason: "insufficient_capacity" } } },
          telemetryReadings: { five_hour: { resetsAtMs: null, resetElapsed: false } }
        });
      });

      const taskA = makeTask({ id: "T-0001" });
      const { poller: pollerA, store: storeA } = makePoller({
        tasks: [taskA],
        now: () => nowMs,
        drainModeEnabled: true,
        drainConfig,
        runsDir,
        launchFn
      });

      // Tick 1 (now=1000): first hold -- persists firstHeldAtMs=1000 to runsDir/.drain-wait/T-0001.json.
      expect(await pollerA.tick()).toBeNull();
      await pollerA.flushDrainPersistence();
      expect(await loadPersistedDrainWaitState({ runsDir })).toEqual({ "T-0001": 1000 });

      // Tick 2 (now=1500): a successful (fake) launch -- must clear BOTH the in-memory tracker
      // AND the persisted sidecar file, not just the former.
      nowMs = 1500;
      shouldFit = true;
      await pollerA.tick();
      await pollerA.flushDrainPersistence();
      expect(await loadPersistedDrainWaitState({ runsDir })).toEqual({});

      // "Reload at 10000ms": a board restart -- a brand-new poller/tracker, seeded only from
      // whatever is on disk right now (nothing, since the launch cleared it), for the card's next
      // attempt (a human moved it back to ready after the first launch's own run finished).
      nowMs = 10000;
      shouldFit = false;
      const seed = await loadPersistedDrainWaitState({ runsDir });
      const restartedTracker = createDrainWaitTracker({ seed });
      const taskB = makeTask({ id: "T-0001", status: "ready" });
      const { poller: pollerB } = makePoller({
        tasks: [taskB],
        now: () => nowMs,
        drainModeEnabled: true,
        drainConfig,
        runsDir,
        launchFn,
        drainTracker: restartedTracker
      });

      expect(await pollerB.tick()).toBeNull();
      // A FRESH deadline (WAITING), never the finished attempt's old one (which would already be
      // expired by now=10000 against a firstHeldAtMs of 1000).
      expect(pollerB.getStatus().drain["T-0001"]).toMatchObject({ status: DRAIN_STATUS.WAITING });
      expect(pollerB.getStatus().drain["T-0001"].status).not.toBe(DRAIN_STATUS.HELD_WAIT_EXPIRED);
    });

    it("the oversized exit also clears the persisted sidecar file, not just the in-memory tracker", async () => {
      let nowMs = 1000;
      const task = makeTask({ id: "T-0001" });
      // First tick: an ordinary hold, so a sidecar file actually exists to clear.
      const launchFn = vi.fn(async ({ id }) => {
        throw capacityFitHoldError("does not fit", {
          admission: { admitted: false, windows: { five_hour: { windowKind: "five_hour", admitted: false, holdReason: "insufficient_capacity" } } },
          telemetryReadings: { five_hour: { resetsAtMs: null, resetElapsed: false } }
        });
      });
      const { poller } = makePoller({ tasks: [task], now: () => nowMs, drainModeEnabled: true, runsDir, launchFn });

      await poller.tick();
      await poller.flushDrainPersistence();
      expect(await loadPersistedDrainWaitState({ runsDir })).toEqual({ "T-0001": 1000 });

      // Next tick: now the SAME card is detected oversized (e.g. its estimate grew) -- the
      // oversized exit must clear the stale sidecar from the earlier ordinary hold too.
      launchFn.mockImplementation(async () => {
        throw capacityFitHoldError("oversized", { drainHeldOversized: true, blockingWindow: "seven_day", reason: "oversized -- split or re-scope" });
      });
      nowMs = 2000;
      await poller.tick();
      await poller.flushDrainPersistence();

      expect(await loadPersistedDrainWaitState({ runsDir })).toEqual({});
    });
  });
});
