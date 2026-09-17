import { describe, it, expect, vi } from "vitest";
import { createOrphanReaper } from "../../src/runner/orphanReaper.js";

// T-0296 -- the residual half of the two-status-writers bug
// (docs/reviews/2026-09-03-run-lifecycle-state-management.md).
//
// #322 stopped the reaper writing status for a card the orchestrator OWNS. What it did not cover
// is the launch window, and on 2026-09-04 T-0302 was reaped there twice while its run was alive:
//
//   card_events, second occurrence:
//     16:45:47.898  status -> in-progress
//     16:46:22.140  status + body -> blocked + "Recovered" note   (34s later)
//
//   ...while at 16:51 the run was still demonstrably healthy: pid 743220 alive, runstate
//   heartbeat refreshed 2s earlier, run log grown 253 KB -> 662 KB. The card said `blocked`.
//
// Mechanism: DEFAULT_GRACE_MS was 15s against a 30s sweep, so a launching card got exactly ONE
// sweep of grace -- and the grace clock started when the REAPER first noticed the card, not when
// the run started. A card that entered in-progress just after a sweep could be reaped on the
// next one, before its liveness markers (pid in the runstate, a written run log) existed.
//
// Both reaps were also SILENT -- no reap/orphan line reached the journal at all -- which is why
// this ran invisibly for hours.

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

/** A reaper whose liveness inference always says "dead" -- the worst case for a launching card. */
function makeReaper({
  tasks,
  activeCardIds = new Set(),
  logger = makeLogger(),
  nowMs = 1_000_000,
  ...overrides
}) {
  const store = makeStore(tasks);
  const clock = { t: nowMs };
  const reaper = createOrphanReaper({
    store,
    hub: { broadcast: vi.fn() },
    activeCardIds,
    runsDir: "/runs",
    logger,
    now: () => clock.t,
    readRunStateFn: async () => null, // no runstate on disk yet -- the launch window
    isRunLiveFn: async () => false, // inference says dead
    freshestRunLogMtimeForTaskFn: async () => null,
    ...overrides
  });
  return { reaper, store, logger, clock };
}

describe("T-0296: a card that just started must survive the launch window", () => {
  it("does NOT reap a card first observed at in-progress on this very sweep", async () => {
    const t = task();
    const { reaper, store } = makeReaper({ tasks: [t] });

    await reaper.sweepOnce();

    expect(store.update).not.toHaveBeenCalled();
    expect(t.status).toBe("in-progress");
  });

  it("does NOT reap it on the NEXT sweep either -- one sweep of grace was the 2026-09-04 bug", async () => {
    const t = task();
    const { reaper, store, clock } = makeReaper({ tasks: [t] });

    await reaper.sweepOnce();
    clock.t += 30_000; // one sweep later -- exactly when T-0302 was reaped
    await reaper.sweepOnce();

    expect(store.update, "reaped one sweep after first observation, as T-0302 was").not.toHaveBeenCalled();
    expect(t.status).toBe("in-progress");
  });

  it("still reaps a genuinely abandoned card once the launch grace has fully elapsed", async () => {
    const t = task();
    const { reaper, store, clock } = makeReaper({ tasks: [t] });

    await reaper.sweepOnce();
    clock.t += 10 * 60 * 1000; // well past any grace
    await reaper.sweepOnce();

    expect(store.update).toHaveBeenCalled();
    expect(t.status).toBe("blocked");
  });

  it("never reaps a card the orchestrator is tracking, regardless of grace or runstate", async () => {
    const t = task();
    const active = new Set(["T-0001"]);
    const { reaper, store, clock } = makeReaper({ tasks: [t], activeCardIds: active });

    await reaper.sweepOnce();
    clock.t += 10 * 60 * 1000;
    await reaper.sweepOnce();

    expect(store.update).not.toHaveBeenCalled();
    expect(t.status).toBe("in-progress");
  });
});

describe("T-0296: no reap decision is ever silent", () => {
  it("logs when it leaves a card alone inside the launch grace", async () => {
    const { reaper, logger } = makeReaper({ tasks: [task()] });

    await reaper.sweepOnce();

    const out = lines(logger);
    expect(out, "a within-grace hold was silent").toMatch(/T-0001/);
    expect(out).toMatch(/grace|too young|just started/i);
  });

  it("logs the reap itself when one does fire", async () => {
    const { reaper, logger, clock } = makeReaper({ tasks: [task()] });

    await reaper.sweepOnce();
    clock.t += 10 * 60 * 1000;
    await reaper.sweepOnce();

    const out = lines(logger);
    expect(out).toMatch(/reaped/i);
    expect(out).toMatch(/T-0001/);
  });

  it("logs that it left an orchestrator-owned card alone", async () => {
    const { reaper, logger } = makeReaper({ tasks: [task()], activeCardIds: new Set(["T-0001"]) });

    await reaper.sweepOnce();

    expect(lines(logger)).toMatch(/T-0001/);
  });
});
