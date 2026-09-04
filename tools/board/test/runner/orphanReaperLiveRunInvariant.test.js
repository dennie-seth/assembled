// T-0296's invariant, stated once and pinned: a run with a live pid, a fresh heartbeat and a
// growing log is NEVER reaped -- regardless of how long it has been running.
//
// #336 pinned the LAUNCH window (a card younger than the grace period). It said nothing about a
// card that has been running for an hour, which is the shape of every long agent run: 8-attempt
// acceptance loops, LoRA training, full-suite validation. This file pins the mid-run half, at
// ages far past any grace window, so no future change to the grace/staleness constants can
// quietly reintroduce a mid-run reap.
import { describe, it, expect, vi } from "vitest";
import { createOrphanReaper } from "../../src/runner/orphanReaper.js";

function task(overrides = {}) {
  return { id: "T-0001", title: "t", status: "in-progress", body: "", ...overrides };
}

function makeStore(tasks) {
  const updated = [];
  return {
    updated,
    list: vi.fn(async () => tasks),
    get: vi.fn(async (id) => tasks.find((t) => t.id === id) ?? null),
    update: vi.fn(async (id, patch) => {
      updated.push({ id, patch });
      const t = tasks.find((x) => x.id === id);
      Object.assign(t, patch);
      return { ...t };
    })
  };
}

const makeLogger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });
const lines = (logger) =>
  [...logger.log.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]
    .map((c) => c.join(" "))
    .join("\n");

const HOUR = 3_600_000;

/** A demonstrably healthy long-running run: live pid, heartbeat seconds old, log still growing. */
function makeHealthyReaper({ tasks, ageMs, logger = makeLogger(), ...overrides }) {
  const nowMs = 10 * HOUR;
  const store = makeStore(tasks);
  const startedAt = nowMs - ageMs;
  const reaper = createOrphanReaper({
    store,
    hub: { broadcast: vi.fn() },
    activeCardIds: new Set(),
    runsDir: "/runs",
    logger,
    now: () => nowMs,
    readRunStateFn: async () => ({
      pid: 4242,
      runLogPath: "/runs/T-0001.jsonl",
      updatedAt: new Date(nowMs - 2_000).toISOString(),
      startedAt: new Date(startedAt).toISOString()
    }),
    isPidAliveFn: () => true,
    isRunLiveFn: async () => true,
    isRunWedgedFn: async () => false,
    freshestRunLogMtimeForTaskFn: async () => nowMs - 2_000,
    ...overrides
  });
  return { reaper, store, logger };
}

describe("T-0296: a live mid-run card is never reaped, at any age", () => {
  for (const [label, ageMs] of [
    ["10 minutes", 10 * 60_000],
    ["1 hour", HOUR],
    ["6 hours", 6 * HOUR]
  ]) {
    it(`does NOT reap a healthy run that has been going for ${label}`, async () => {
      const t = task();
      const { reaper, store } = makeHealthyReaper({ tasks: [t], ageMs });

      await reaper.sweepOnce();

      expect(store.update).not.toHaveBeenCalled();
      expect(t.status).toBe("in-progress");
    });
  }

  it("does NOT reap a healthy long run on startup either -- reapOnStartup has no grace window", async () => {
    const t = task();
    const { reaper, store } = makeHealthyReaper({ tasks: [t], ageMs: 2 * HOUR });

    await reaper.reapOnStartup();

    expect(store.update).not.toHaveBeenCalled();
    expect(t.status).toBe("in-progress");
  });

  it("never flaps: ten consecutive sweeps against one steady live run change nothing", async () => {
    const t = task();
    const { reaper, store } = makeHealthyReaper({ tasks: [t], ageMs: 3 * HOUR });

    for (let i = 0; i < 10; i += 1) await reaper.sweepOnce();

    expect(store.update).not.toHaveBeenCalled();
  });

  it("says so out loud -- a decision to leave a live card alone must be visible", async () => {
    const t = task();
    const { reaper, logger } = makeHealthyReaper({ tasks: [t], ageMs: 2 * HOUR });

    await reaper.sweepOnce();

    expect(lines(logger)).toMatch(/T-0001/);
  });

  it("still reaps a long-running card whose process is genuinely gone", async () => {
    const t = task();
    const clock = { t: 10 * HOUR };
    const store = makeStore([t]);
    const reaper = createOrphanReaper({
      store,
      hub: { broadcast: vi.fn() },
      activeCardIds: new Set(),
      runsDir: "/runs",
      logger: makeLogger(),
      now: () => clock.t,
      readRunStateFn: async () => null,
      isPidAliveFn: () => false,
      isRunLiveFn: async () => false,
      isRunWedgedFn: async () => false,
      freshestRunLogMtimeForTaskFn: async () => 6 * HOUR
    });

    // first sweep starts the grace clock; the reap lands once the grace has fully elapsed
    await reaper.sweepOnce();
    clock.t += 10 * 60_000;
    await reaper.sweepOnce();

    expect(t.status).toBe("blocked");
  });
});
