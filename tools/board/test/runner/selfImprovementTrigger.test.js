import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  evaluateTrigger,
  createSelfImprovementLoop,
  selfImproveEnabledFromEnv,
  reworkThresholdFromEnv,
  minReworkSampleFromEnv,
  minIntervalDaysFromEnv,
  minRetryCapBlockedFromEnv,
  minRecoveredFromEnv
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

function autoProposedTask({ id = "T-0100", status = "done", baselineDone = 0, proposedAt } = {}) {
  const marker = proposedAt
    ? `<!-- flow-stats-self-improve: baseline-done=${baselineDone} proposed-at=${proposedAt} -->`
    : `<!-- flow-stats-self-improve: baseline-done=${baselineDone} -->`;
  return { id, status, body: `${marker}\n\n## Context\n` };
}

function failNote(id, timestamp) {
  return { id, status: "done", body: `## Validation: FAIL (${timestamp})\n\nsome failure\n` };
}

describe("evaluateTrigger", () => {
  const defaults = {
    reworkThreshold: 0.3,
    minReworkSample: 10,
    minIntervalDays: 7,
    minRetryCapBlocked: 3,
    minRecovered: 3,
    now: () => new Date("2026-08-07T00:00:00.000Z")
  };

  it("does not fire when nothing has crossed any threshold (quiet week -> no filler card)", () => {
    const stats = makeStats({ byStatus: { done: 50 }, reworkTotal: 1, passTotal: 19, reworkRate: 0.05, reworkSample: 20 });
    expect(evaluateTrigger({ stats, tasks: [], ...defaults })).toBeNull();
  });

  it("does not fire purely on card-completion volume -- there is no interval/volume trigger anymore", () => {
    const stats = makeStats({ byStatus: { done: 500 }, reworkTotal: 0, passTotal: 0, reworkRate: 0, reworkSample: 0 });
    expect(evaluateTrigger({ stats, tasks: [], ...defaults })).toBeNull();
  });

  it("fires the rework-rate reason once the rate crosses threshold with enough sample, citing evidence", () => {
    const tasks = [failNote("T-0201", "2026-08-01T00:00:00.000Z"), failNote("T-0202", "2026-08-02T00:00:00.000Z")];
    const stats = makeStats({ reworkTotal: 8, passTotal: 2, reworkRate: 0.8, reworkSample: 10 });
    const result = evaluateTrigger({ stats, tasks, ...defaults });

    expect(result).toMatchObject({ reason: "rework-rate", reworkRate: 0.8, reworkSample: 10 });
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence.map((e) => e.id)).toContain("T-0202");
    expect(result.windowStart).toBe("2026-08-01T00:00:00.000Z");
    expect(result.windowEnd).toBe("2026-08-02T00:00:00.000Z");
  });

  it("does not fire the rework-rate reason when the sample is below minReworkSample, even at 100% rate", () => {
    const stats = makeStats({ reworkTotal: 2, passTotal: 0, reworkRate: 1, reworkSample: 2 });
    expect(evaluateTrigger({ stats, tasks: [], ...defaults })).toBeNull();
  });

  it("does not fire the rework-rate reason when the rate is below threshold", () => {
    const stats = makeStats({ reworkTotal: 1, passTotal: 19, reworkRate: 0.05, reworkSample: 20 });
    expect(evaluateTrigger({ stats, tasks: [], ...defaults })).toBeNull();
  });

  it("fires the retry-cap-blocked reason once repeated retry-cap exhaustions cross the floor", () => {
    const tasks = [
      { id: "T-0301", status: "blocked", body: "## Validation: FAIL (2026-08-03T00:00:00.000Z)\n\nAuto-retry limit reached\n" },
      { id: "T-0302", status: "blocked", body: "## Validation: FAIL (2026-08-04T00:00:00.000Z)\n\nAuto-retry limit reached\n" },
      { id: "T-0303", status: "blocked", body: "## Validation: FAIL (2026-08-05T00:00:00.000Z)\n\nAuto-retry limit reached\n" }
    ];
    const stats = makeStats({ retryCapBlockedCount: 3 });
    const result = evaluateTrigger({ stats, tasks, ...defaults });

    expect(result).toMatchObject({ reason: "retry-cap-blocked", retryCapBlockedCount: 3 });
    expect(result.evidence.map((e) => e.id).sort()).toEqual(["T-0301", "T-0302", "T-0303"]);
  });

  it("does not fire retry-cap-blocked below the minimum floor", () => {
    const stats = makeStats({ retryCapBlockedCount: 2 });
    expect(evaluateTrigger({ stats, tasks: [], ...defaults })).toBeNull();
  });

  it("fires the orphan-recovery reason once repeated reaper recoveries cross the floor", () => {
    const tasks = [
      { id: "T-0401", status: "done", body: "## Recovered (2026-08-01T00:00:00.000Z)\n\nreset from in-progress\n" },
      { id: "T-0402", status: "done", body: "## Recovered (2026-08-02T00:00:00.000Z)\n\nreset from validation\n" },
      { id: "T-0403", status: "done", body: "## Recovered (2026-08-03T00:00:00.000Z)\n\nreset from in-progress\n" }
    ];
    const stats = makeStats({ recoveredTotal: 3 });
    const result = evaluateTrigger({ stats, tasks, ...defaults });

    expect(result).toMatchObject({ reason: "orphan-recovery", recoveredTotal: 3 });
    expect(result.evidence.length).toBe(3);
  });

  it("does not fire orphan-recovery below the minimum floor", () => {
    const stats = makeStats({ recoveredTotal: 2 });
    expect(evaluateTrigger({ stats, tasks: [], ...defaults })).toBeNull();
  });

  it("prefers rework-rate over retry-cap-blocked and orphan-recovery when multiple cross at once", () => {
    const stats = makeStats({ reworkTotal: 8, passTotal: 2, reworkRate: 0.8, reworkSample: 10, retryCapBlockedCount: 5, recoveredTotal: 5 });
    const result = evaluateTrigger({ stats, tasks: [], ...defaults });
    expect(result.reason).toBe("rework-rate");
  });

  describe("dedup: while the latest auto-proposed card is still open", () => {
    it("does not fire regardless of how far past thresholds the numbers are", () => {
      const tasks = [autoProposedTask({ id: "T-0050", status: "in-progress", baselineDone: 0 })];
      const stats = makeStats({ reworkTotal: 9, passTotal: 1, reworkRate: 0.9, reworkSample: 10, retryCapBlockedCount: 10 });
      expect(evaluateTrigger({ stats, tasks, ...defaults })).toBeNull();
    });

    it("blocked counts as still open (unactioned)", () => {
      const tasks = [autoProposedTask({ id: "T-0050", status: "blocked", baselineDone: 0 })];
      const stats = makeStats({ reworkTotal: 9, passTotal: 1, reworkRate: 0.9, reworkSample: 10 });
      expect(evaluateTrigger({ stats, tasks, ...defaults })).toBeNull();
    });
  });

  describe("weekly cadence gate", () => {
    it("does not fire again within minIntervalDays of the last proposal, even though thresholds are crossed", () => {
      const tasks = [autoProposedTask({ id: "T-0050", status: "retired", baselineDone: 0, proposedAt: "2026-08-02T00:00:00.000Z" })];
      const stats = makeStats({ reworkTotal: 8, passTotal: 2, reworkRate: 0.8, reworkSample: 10 });
      // now is 2026-08-07, only 5 days after the last proposal (< 7)
      expect(evaluateTrigger({ stats, tasks, ...defaults })).toBeNull();
    });

    it("fires again once minIntervalDays have elapsed since the last proposal", () => {
      const tasks = [autoProposedTask({ id: "T-0050", status: "retired", baselineDone: 0, proposedAt: "2026-07-31T00:00:00.000Z" })];
      const stats = makeStats({ reworkTotal: 8, passTotal: 2, reworkRate: 0.8, reworkSample: 10 });
      // now is 2026-08-07, exactly 7 days after the last proposal
      const result = evaluateTrigger({ stats, tasks, ...defaults });
      expect(result).toMatchObject({ reason: "rework-rate" });
    });

    it("does not require a 7-day wait before the very first proposal ever", () => {
      const stats = makeStats({ reworkTotal: 8, passTotal: 2, reworkRate: 0.8, reworkSample: 10 });
      const result = evaluateTrigger({ stats, tasks: [], ...defaults });
      expect(result).toMatchObject({ reason: "rework-rate" });
    });

    it("treats a legacy marker with no proposed-at timestamp as not cadence-gating (back-compat)", () => {
      const tasks = [autoProposedTask({ id: "T-0050", status: "retired", baselineDone: 0 })];
      const stats = makeStats({ reworkTotal: 8, passTotal: 2, reworkRate: 0.8, reworkSample: 10 });
      const result = evaluateTrigger({ stats, tasks, ...defaults });
      expect(result).toMatchObject({ reason: "rework-rate" });
    });

    it("respects a configured minIntervalDays other than the default", () => {
      const tasks = [autoProposedTask({ id: "T-0050", status: "retired", baselineDone: 0, proposedAt: "2026-08-06T00:00:00.000Z" })];
      const stats = makeStats({ reworkTotal: 8, passTotal: 2, reworkRate: 0.8, reworkSample: 10 });
      expect(evaluateTrigger({ stats, tasks, ...defaults, minIntervalDays: 1 })).toMatchObject({ reason: "rework-rate" });
      expect(evaluateTrigger({ stats, tasks, ...defaults, minIntervalDays: 2 })).toBeNull();
    });
  });
});

describe("env helpers", () => {
  const keys = [
    "FLOW_STATS_SELFIMPROVE_ENABLED",
    "FLOW_STATS_SELFIMPROVE_REWORK_THRESHOLD",
    "FLOW_STATS_SELFIMPROVE_MIN_REWORK_SAMPLE",
    "FLOW_STATS_SELFIMPROVE_MIN_INTERVAL_DAYS",
    "FLOW_STATS_SELFIMPROVE_MIN_RETRY_CAP_BLOCKED",
    "FLOW_STATS_SELFIMPROVE_MIN_RECOVERED"
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

  it("reworkThresholdFromEnv defaults to 0.3 and reads a valid override", () => {
    delete process.env.FLOW_STATS_SELFIMPROVE_REWORK_THRESHOLD;
    expect(reworkThresholdFromEnv()).toBe(0.3);
    process.env.FLOW_STATS_SELFIMPROVE_REWORK_THRESHOLD = "0.5";
    expect(reworkThresholdFromEnv()).toBe(0.5);
  });

  it("minReworkSampleFromEnv defaults to 10 and reads a valid override", () => {
    delete process.env.FLOW_STATS_SELFIMPROVE_MIN_REWORK_SAMPLE;
    expect(minReworkSampleFromEnv()).toBe(10);
    process.env.FLOW_STATS_SELFIMPROVE_MIN_REWORK_SAMPLE = "8";
    expect(minReworkSampleFromEnv()).toBe(8);
  });

  it("minIntervalDaysFromEnv defaults to 7 and reads a valid override", () => {
    delete process.env.FLOW_STATS_SELFIMPROVE_MIN_INTERVAL_DAYS;
    expect(minIntervalDaysFromEnv()).toBe(7);
    process.env.FLOW_STATS_SELFIMPROVE_MIN_INTERVAL_DAYS = "14";
    expect(minIntervalDaysFromEnv()).toBe(14);
  });

  it("minRetryCapBlockedFromEnv defaults to 3 and reads a valid override", () => {
    delete process.env.FLOW_STATS_SELFIMPROVE_MIN_RETRY_CAP_BLOCKED;
    expect(minRetryCapBlockedFromEnv()).toBe(3);
    process.env.FLOW_STATS_SELFIMPROVE_MIN_RETRY_CAP_BLOCKED = "5";
    expect(minRetryCapBlockedFromEnv()).toBe(5);
  });

  it("minRecoveredFromEnv defaults to 3 and reads a valid override", () => {
    delete process.env.FLOW_STATS_SELFIMPROVE_MIN_RECOVERED;
    expect(minRecoveredFromEnv()).toBe(3);
    process.env.FLOW_STATS_SELFIMPROVE_MIN_RECOVERED = "5";
    expect(minRecoveredFromEnv()).toBe(5);
  });
});

function makeFakeStore(tasks) {
  return { list: vi.fn(async () => tasks) };
}

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function reworkTasks() {
  return Array.from({ length: 8 }, (_, i) => failNote(`T-${2000 + i}`, `2026-08-0${(i % 9) + 1}T00:00:00.000Z`)).concat(
    Array.from({ length: 2 }, (_, i) => ({ id: `T-${3000 + i}`, status: "done", body: "## Validation: PASS (2026-08-01T00:00:00.000Z)\n" }))
  );
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

  it("does not create a card when enabled but no trigger condition is met (quiet week)", async () => {
    const store = makeFakeStore([{ id: "T-0001", status: "backlog", body: "" }]);
    const createCardFn = vi.fn();
    const loop = createSelfImprovementLoop({
      store,
      enabled: true,
      reworkThreshold: 0.3,
      minReworkSample: 10,
      createCardFn,
      logger: makeLogger()
    });

    const result = await loop.sweepOnce();

    expect(result).toBeNull();
    expect(createCardFn).not.toHaveBeenCalled();
  });

  it("creates a proposal card through createCardFn when the rework-rate trigger fires", async () => {
    const store = makeFakeStore(reworkTasks());
    const created = { id: "T-9999", title: "proposal" };
    const createCardFn = vi.fn(async () => created);
    const loop = createSelfImprovementLoop({
      store,
      enabled: true,
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

  it("does not create a second proposal card on the very next sweep once one was already created (cadence + dedup)", async () => {
    const tasks = reworkTasks();
    const store = makeFakeStore(tasks);
    let createdCard = null;
    const createCardFn = vi.fn(async ({ fields }) => {
      createdCard = { id: "T-9999", status: fields.status, body: fields.body };
      tasks.push(createdCard);
      return createdCard;
    });
    const loop = createSelfImprovementLoop({
      store,
      enabled: true,
      reworkThreshold: 0.3,
      minReworkSample: 5,
      createCardFn,
      logger: makeLogger()
    });

    await loop.sweepOnce();
    expect(createCardFn).toHaveBeenCalledTimes(1);

    await loop.sweepOnce();
    expect(createCardFn).toHaveBeenCalledTimes(1);
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
    const store = makeFakeStore(reworkTasks());
    const createCardFn = vi.fn(async () => { throw new Error("git commit failed"); });
    const logger = makeLogger();
    const loop = createSelfImprovementLoop({ store, enabled: true, minReworkSample: 5, createCardFn, logger });

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
    const store = makeFakeStore(reworkTasks());
    const createCardFn = vi.fn(async () => ({ id: "T-9999" }));
    const loop = createSelfImprovementLoop({
      store,
      enabled: true,
      minReworkSample: 5,
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
