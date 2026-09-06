import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAutoLaunchPoller,
  selectNextCard,
  autoLaunchEnabledFromEnv,
  autoLaunchIntervalMsFromEnv,
  autoLaunchUsageMaxFromEnv,
  DEFAULT_AUTO_LAUNCH_INTERVAL_MS,
  DEFAULT_AUTO_LAUNCH_USAGE_MAX
} from "../../src/runner/autoLaunchPoller.js";
import { CardLaunchError } from "../../src/runner/cardLaunch.js";

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
  return { list: vi.fn(async () => tasks), get: vi.fn(async (id) => tasks.find((t) => t.id === id) ?? null) };
}

function makeOrchestrator({ active = false } = {}) {
  return { hasActiveRuns: vi.fn(() => active), isRunning: vi.fn(() => false) };
}

function makePoller({
  tasks = [makeTask()],
  active = false,
  usage = { utilization: 0, status: "allowed", logPath: "/runs/x.jsonl", reason: "status=allowed" },
  launchFn = vi.fn(async ({ id }) => makeTask({ id })),
  logger = makeLogger(),
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
    launchFn,
    logger,
    ...overrides
  });
  return { poller, store, orchestrator, readUsage, launchFn, logger };
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
