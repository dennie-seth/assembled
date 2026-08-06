import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  evaluateTrigger,
  createSelfImprovementLoop,
  selfImproveEnabledFromEnv,
  intervalCardsFromEnv,
  reworkThresholdFromEnv,
  minReworkSampleFromEnv
} from "../../src/runner/selfImprovementTrigger.js";

function makeStats(overrides = {}) {
  return {
    totalCards: 10,
    reworkTotal: 0,
    passTotal: 0,
    reworkRate: 0,
    reworkSample: 0,
    recoveredTotal: 0,
    retryCapBlockedCount: 0,
    avgReworkPerDoneCard: 0,
    ...overrides,
    byStatus: {
      backlog: 0,
      ready: 0,
      "in-progress": 0,
      validation: 0,
      review: 0,
      done: 0,
      blocked: 0,
      retired: 0,
      ...(overrides.byStatus ?? {})
    }
  };
}

function autoProposedTask({ id = "T-0100", status = "done", baselineDone = 0 } = {}) {
  return {
    id,
    status,
    body: `<!-- flow-stats-self-improve: baseline-done=${baselineDone} -->\n\n## Context\n`
  };
}

describe("evaluateTrigger", () => {
  const defaults = { intervalCards: 10, reworkThreshold: 0.3, minReworkSample: 5 };

  it("does not fire when nothing has crossed either threshold", () => {
    const stats = makeStats({ byStatus: { done: 3 } });
    expect(evaluateTrigger({ stats, tasks: [], ...defaults })).toBeNull();
  });

  it("fires the interval reason once doneCount - baseline >= intervalCards", () => {
    const stats = makeStats({ byStatus: { done: 10 } });
    const result = evaluateTrigger({ stats, tasks: [], ...defaults });
    expect(result).toMatchObject({ reason: "interval", doneDelta: 10 });
  });

  it("uses the most recent auto-proposed card's marker as the baseline, not zero", () => {
    const tasks = [autoProposedTask({ id: "T-0050", status: "done", baselineDone: 5 })];
    const stats = makeStats({ byStatus: { done: 14 } }); // 14 - 5 = 9, below interval of 10
    expect(evaluateTrigger({ stats, tasks, ...defaults })).toBeNull();

    const statsAtThreshold = makeStats({ byStatus: { done: 15 } }); // 15 - 5 = 10
    expect(evaluateTrigger({ stats: statsAtThreshold, tasks, ...defaults })).toMatchObject({ reason: "interval" });
  });

  it("does not fire (of either reason) while the latest auto-proposed card is still open", () => {
    const tasks = [autoProposedTask({ id: "T-0050", status: "in-progress", baselineDone: 0 })];
    const stats = makeStats({
      byStatus: { done: 50 },
      reworkTotal: 9,
      passTotal: 1,
      reworkRate: 0.9,
      reworkSample: 10
    });
    expect(evaluateTrigger({ stats, tasks, ...defaults })).toBeNull();
  });

  it("fires again once the previous auto-proposed card reached a closed status (done or retired)", () => {
    const doneTasks = [autoProposedTask({ id: "T-0050", status: "done", baselineDone: 0 })];
    const retiredTasks = [autoProposedTask({ id: "T-0050", status: "retired", baselineDone: 0 })];
    const stats = makeStats({ byStatus: { done: 10 } });

    expect(evaluateTrigger({ stats, tasks: doneTasks, ...defaults })).toMatchObject({ reason: "interval" });
    expect(evaluateTrigger({ stats, tasks: retiredTasks, ...defaults })).toMatchObject({ reason: "interval" });
  });

  it("fires the rework-rate reason once the rate crosses threshold with enough sample", () => {
    const stats = makeStats({ reworkTotal: 4, passTotal: 1, reworkRate: 0.8, reworkSample: 5 });
    const result = evaluateTrigger({ stats, tasks: [], ...defaults });
    expect(result).toMatchObject({ reason: "rework-rate", reworkRate: 0.8 });
  });

  it("does not fire the rework-rate reason when the sample is below minReworkSample, even at 100% rate", () => {
    const stats = makeStats({ reworkTotal: 2, passTotal: 0, reworkRate: 1, reworkSample: 2 });
    expect(evaluateTrigger({ stats, tasks: [], ...defaults })).toBeNull();
  });

  it("does not fire the rework-rate reason when the rate is below threshold", () => {
    const stats = makeStats({ reworkTotal: 1, passTotal: 9, reworkRate: 0.1, reworkSample: 10 });
    expect(evaluateTrigger({ stats, tasks: [], ...defaults })).toBeNull();
  });

  it("prefers the interval reason when both conditions are true at once", () => {
    const stats = makeStats({
      byStatus: { done: 10 },
      reworkTotal: 8,
      passTotal: 2,
      reworkRate: 0.8,
      reworkSample: 10
    });
    const result = evaluateTrigger({ stats, tasks: [], ...defaults });
    expect(result.reason).toBe("interval");
  });
});

describe("env helpers", () => {
  const keys = [
    "FLOW_STATS_SELFIMPROVE_ENABLED",
    "FLOW_STATS_SELFIMPROVE_INTERVAL_CARDS",
    "FLOW_STATS_SELFIMPROVE_REWORK_THRESHOLD",
    "FLOW_STATS_SELFIMPROVE_MIN_REWORK_SAMPLE"
  ];
  const originals = {};

  beforeEach(() => {
    for (const key of keys) originals[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of keys) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
  });

  it("selfImproveEnabledFromEnv defaults to false when unset", () => {
    delete process.env.FLOW_STATS_SELFIMPROVE_ENABLED;
    expect(selfImproveEnabledFromEnv()).toBe(false);
  });

  it.each(["1", "true", "on", "yes", "TRUE", "On"])("selfImproveEnabledFromEnv is true when set to %s", (value) => {
    process.env.FLOW_STATS_SELFIMPROVE_ENABLED = value;
    expect(selfImproveEnabledFromEnv()).toBe(true);
  });

  it.each(["0", "false", "off", "no", "", "garbage"])("selfImproveEnabledFromEnv is false when set to %s", (value) => {
    process.env.FLOW_STATS_SELFIMPROVE_ENABLED = value;
    expect(selfImproveEnabledFromEnv()).toBe(false);
  });

  it("intervalCardsFromEnv defaults to 10 and reads a valid override", () => {
    delete process.env.FLOW_STATS_SELFIMPROVE_INTERVAL_CARDS;
    expect(intervalCardsFromEnv()).toBe(10);
    process.env.FLOW_STATS_SELFIMPROVE_INTERVAL_CARDS = "25";
    expect(intervalCardsFromEnv()).toBe(25);
  });

  it("reworkThresholdFromEnv defaults to 0.3 and reads a valid override", () => {
    delete process.env.FLOW_STATS_SELFIMPROVE_REWORK_THRESHOLD;
    expect(reworkThresholdFromEnv()).toBe(0.3);
    process.env.FLOW_STATS_SELFIMPROVE_REWORK_THRESHOLD = "0.5";
    expect(reworkThresholdFromEnv()).toBe(0.5);
  });

  it("minReworkSampleFromEnv defaults to 5 and reads a valid override", () => {
    delete process.env.FLOW_STATS_SELFIMPROVE_MIN_REWORK_SAMPLE;
    expect(minReworkSampleFromEnv()).toBe(5);
    process.env.FLOW_STATS_SELFIMPROVE_MIN_REWORK_SAMPLE = "8";
    expect(minReworkSampleFromEnv()).toBe(8);
  });
});

function makeFakeStore(tasks) {
  return { list: vi.fn(async () => tasks) };
}

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("createSelfImprovementLoop / sweepOnce", () => {
  it("does nothing and returns null when disabled", async () => {
    const store = makeFakeStore([]);
    const createCardFn = vi.fn();
    const loop = createSelfImprovementLoop({ store, enabled: false, createCardFn, logger: makeLogger() });

    const result = await loop.sweepOnce();

    expect(result).toBeNull();
    expect(store.list).not.toHaveBeenCalled();
    expect(createCardFn).not.toHaveBeenCalled();
  });

  it("does not create a card when enabled but no trigger condition is met", async () => {
    const store = makeFakeStore([{ id: "T-0001", status: "backlog", body: "" }]);
    const createCardFn = vi.fn();
    const loop = createSelfImprovementLoop({
      store,
      enabled: true,
      intervalCards: 10,
      reworkThreshold: 0.3,
      minReworkSample: 5,
      createCardFn,
      logger: makeLogger()
    });

    const result = await loop.sweepOnce();

    expect(result).toBeNull();
    expect(createCardFn).not.toHaveBeenCalled();
  });

  it("creates a proposal card through createCardFn when the interval trigger fires", async () => {
    const doneTasks = Array.from({ length: 10 }, (_, i) => ({ id: `T-${1000 + i}`, status: "done", body: "" }));
    const store = makeFakeStore(doneTasks);
    const created = { id: "T-9999", title: "proposal" };
    const createCardFn = vi.fn(async () => created);
    const loop = createSelfImprovementLoop({
      store,
      enabled: true,
      intervalCards: 10,
      reworkThreshold: 0.3,
      minReworkSample: 5,
      createCardFn,
      logger: makeLogger()
    });

    const result = await loop.sweepOnce();

    expect(createCardFn).toHaveBeenCalledTimes(1);
    const [args] = createCardFn.mock.calls[0];
    expect(args.fields.status).toBe("backlog");
    expect(args.fields.agent).toBeNull();
    expect(result).toBe(created);
  });

  it("retries store.list() exactly once on a transient read failure, then proceeds normally", async () => {
    let calls = 0;
    const store = {
      list: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient EBUSY");
        return [];
      })
    };
    const createCardFn = vi.fn();
    const logger = makeLogger();
    const loop = createSelfImprovementLoop({ store, enabled: true, createCardFn, logger });

    const result = await loop.sweepOnce();

    expect(store.list).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs an error and returns null (never throws) when store.list() fails twice in a row", async () => {
    const store = { list: vi.fn(async () => { throw new Error("disk on fire"); }) };
    const createCardFn = vi.fn();
    const logger = makeLogger();
    const loop = createSelfImprovementLoop({ store, enabled: true, createCardFn, logger });

    const result = await loop.sweepOnce();

    expect(store.list).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
    expect(createCardFn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatch(/disk on fire/);
  });

  it("logs an error and returns null (never throws) when createCardFn fails, without retrying it", async () => {
    const doneTasks = Array.from({ length: 10 }, (_, i) => ({ id: `T-${1000 + i}`, status: "done", body: "" }));
    const store = makeFakeStore(doneTasks);
    const createCardFn = vi.fn(async () => { throw new Error("git commit failed"); });
    const logger = makeLogger();
    const loop = createSelfImprovementLoop({ store, enabled: true, intervalCards: 10, createCardFn, logger });

    const result = await loop.sweepOnce();

    expect(createCardFn).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatch(/git commit failed/);
  });
});

describe("createSelfImprovementLoop / start & stop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweeps on the configured interval once started", async () => {
    const doneTasks = Array.from({ length: 10 }, (_, i) => ({ id: `T-${1000 + i}`, status: "done", body: "" }));
    const store = makeFakeStore(doneTasks);
    const createCardFn = vi.fn(async () => ({ id: "T-9999" }));
    const loop = createSelfImprovementLoop({
      store,
      enabled: true,
      intervalCards: 10,
      intervalMs: 1000,
      createCardFn,
      logger: makeLogger()
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(1000);
    loop.stop();

    expect(createCardFn).toHaveBeenCalledTimes(1);
  });

  it("never starts the interval when disabled", async () => {
    const store = makeFakeStore([]);
    const createCardFn = vi.fn();
    const loop = createSelfImprovementLoop({ store, enabled: false, intervalMs: 1000, createCardFn, logger: makeLogger() });

    loop.start();
    await vi.advanceTimersByTimeAsync(5000);

    expect(store.list).not.toHaveBeenCalled();
  });

  it("does not sweep after stop is called", async () => {
    const store = makeFakeStore([]);
    const createCardFn = vi.fn();
    const loop = createSelfImprovementLoop({ store, enabled: true, intervalMs: 1000, createCardFn, logger: makeLogger() });

    loop.start();
    loop.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(store.list).not.toHaveBeenCalled();
  });
});
