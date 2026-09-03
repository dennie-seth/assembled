import { describe, it, expect, vi } from "vitest";
import { createOrphanReaper } from "../../src/runner/orphanReaper.js";

/**
 * Fix-plan items #1 and #2 from docs/reviews/2026-09-03-run-lifecycle-state-management.md.
 *
 * #1 The orchestrator's in-memory `activeCardIds` is the authority on whether a run is live. The
 *    reaper may not write card status for a card the orchestrator owns, and may not evict from
 *    that Set any id it did not itself add.
 * #2 Every reap emits a diagnostic line. Reaps were completely silent (8 fired on 2026-09-03,
 *    0 journal lines), which is why the defect hid for a day and sent T-0289 to the wrong cause.
 */

function makeTask(overrides = {}) {
  return { id: "T-0001", title: "Some card", status: "in-progress", body: "## Context\n\nx\n", ...overrides };
}

function makeStore(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return {
    async list() {
      return [...byId.values()];
    },
    async update(id, patch) {
      const existing = byId.get(id);
      if (!existing) throw new Error(`Task ${id} not found`);
      const updated = { ...existing, ...patch };
      byId.set(id, updated);
      return updated;
    },
    _byId: byId
  };
}

const makeHub = () => ({ broadcast: vi.fn() });
const makeLogger = () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() });
const lines = (logger) => logger.log.mock.calls.map((c) => String(c[0]));

/** A reaper whose liveness verdict is forced, so these tests exercise ownership, not liveness. */
function makeReaper({ store, hub, logger, activeCardIds, verdict = "dead", runsDir = "/runs", extra = {} }) {
  return createOrphanReaper({
    store,
    hub,
    activeCardIds,
    logger,
    enabled: true,
    runsDir,
    graceMs: 0,
    isRunLiveFn: async () => verdict !== "dead",
    isRunWedgedFn: async () => verdict === "wedged",
    isPidAliveFn: () => verdict === "alive" || verdict === "wedged",
    readRunStateFn: async () => ({ pid: 4242, runLogPath: "/runs/T-0001-x.jsonl", updatedAt: new Date().toISOString() }),
    statFn: async () => ({ mtimeMs: Date.now() }),
    killPidGroupFn: vi.fn(async () => {}),
    ...extra
  });
}

describe("#1 the reaper must not write status for a card the orchestrator is tracking", () => {
  it("does NOT reap or write blocked for a tracked card, even on a dead verdict", async () => {
    const store = makeStore([makeTask({ status: "in-progress" })]);
    const hub = makeHub();
    const logger = makeLogger();
    const activeCardIds = new Set(["T-0001"]); // owned by a live runCard()
    const reaper = makeReaper({ store, hub, logger, activeCardIds, verdict: "dead" });

    const reaped = await reaper.sweepOnce();

    expect(reaped).toEqual([]);
    expect(store._byId.get("T-0001").status).toBe("in-progress");
    expect(store._byId.get("T-0001").body).not.toMatch(/## Recovered/);
    expect(hub.broadcast).not.toHaveBeenCalled();
  });

  it("does NOT evict a card it did not readopt from activeCardIds", async () => {
    const store = makeStore([makeTask({ status: "validation" })]);
    const activeCardIds = new Set(["T-0001"]);
    const reaper = makeReaper({ store, hub: makeHub(), logger: makeLogger(), activeCardIds, verdict: "dead" });

    await reaper.sweepOnce();

    expect(activeCardIds.has("T-0001")).toBe(true);
  });

  it("does not write status when the card becomes tracked DURING the liveness check (TOCTOU)", async () => {
    // The grace window and the awaited liveness check both yield. A run can legitimately start in
    // that gap -- POST /run or the auto-launch poller -- and the reap must not land on top of it.
    const store = makeStore([makeTask({ status: "in-progress" })]);
    const hub = makeHub();
    const activeCardIds = new Set(); // untracked when the sweep starts
    const reaper = makeReaper({
      store,
      hub,
      logger: makeLogger(),
      activeCardIds,
      extra: {
        isRunLiveFn: async () => {
          activeCardIds.add("T-0001"); // runCard() picks the card up mid-check
          return false;
        }
      }
    });

    const reaped = await reaper.sweepOnce();

    expect(reaped).toEqual([]);
    expect(store._byId.get("T-0001").status).toBe("in-progress");
  });

  it("still kills a wedged tracked run's process but never writes its status", async () => {
    const store = makeStore([makeTask({ status: "in-progress" })]);
    const killPidGroupFn = vi.fn(async () => {});
    const activeCardIds = new Set(["T-0001"]);
    const reaper = makeReaper({
      store,
      hub: makeHub(),
      logger: makeLogger(),
      activeCardIds,
      verdict: "wedged",
      extra: { killPidGroupFn }
    });

    await reaper.sweepOnce();

    expect(killPidGroupFn).toHaveBeenCalled();
    expect(store._byId.get("T-0001").status).toBe("in-progress");
    expect(activeCardIds.has("T-0001")).toBe(true);
  });
});

describe("#1 genuine restart-survivor orphans are still recovered", () => {
  it("reaps an untracked card with no evidence of life (the reaper's real job)", async () => {
    const store = makeStore([makeTask({ status: "in-progress" })]);
    const hub = makeHub();
    const reaper = makeReaper({ store, hub, logger: makeLogger(), activeCardIds: new Set(), verdict: "dead" });

    const reaped = await reaper.sweepOnce();

    expect(reaped).toEqual(["T-0001"]);
    expect(store._byId.get("T-0001").status).toBe("blocked");
    expect(store._byId.get("T-0001").body).toMatch(/## Recovered/);
  });

  it("reapOnStartup still recovers a genuinely dead orphan", async () => {
    const store = makeStore([makeTask({ status: "validation" })]);
    const reaper = makeReaper({ store, hub: makeHub(), logger: makeLogger(), activeCardIds: new Set(), verdict: "dead" });

    const reaped = await reaper.reapOnStartup();

    expect(reaped).toEqual(["T-0001"]);
    expect(store._byId.get("T-0001").status).toBe("blocked");
  });

  it("releases and reaps a card the reaper itself readopted once its run dies", async () => {
    // Preserves T-0289/#314's fix: a readopted card has no other exit from activeCardIds, so the
    // reaper -- which added it -- must be the one to remove it. That is cleaning up its own
    // entry, not evicting the orchestrator's.
    const store = makeStore([makeTask({ status: "in-progress" })]);
    const activeCardIds = new Set();
    let alive = true;
    const reaper = makeReaper({
      store,
      hub: makeHub(),
      logger: makeLogger(),
      activeCardIds,
      extra: {
        isRunLiveFn: async () => alive,
        isPidAliveFn: () => alive,
        isRunWedgedFn: async () => false
      }
    });

    await reaper.sweepOnce(); // verdict alive -> readopt
    expect(activeCardIds.has("T-0001")).toBe(true);
    expect(store._byId.get("T-0001").status).toBe("in-progress");

    alive = false;
    const reaped = await reaper.sweepOnce(); // now genuinely dead -> release + reap

    expect(reaped).toEqual(["T-0001"]);
    expect(activeCardIds.has("T-0001")).toBe(false);
    expect(store._byId.get("T-0001").status).toBe("blocked");
  });
});

describe("#2 every reap emits a diagnostic line", () => {
  it("logs a reap from sweepOnce with the card id, pid and liveness inputs", async () => {
    const store = makeStore([makeTask({ status: "in-progress" })]);
    const logger = makeLogger();
    const reaper = makeReaper({ store, hub: makeHub(), logger, activeCardIds: new Set(), verdict: "dead" });

    await reaper.sweepOnce();

    const reapLine = lines(logger).find((l) => /orphan-reaper: reaped/.test(l));
    expect(reapLine).toBeDefined();
    expect(reapLine).toContain("T-0001");
    expect(reapLine).toContain("in-progress");
    expect(reapLine).toMatch(/pid=4242/);
    expect(reapLine).toMatch(/pidAlive=/);
    expect(reapLine).toMatch(/logAge=/);
  });

  it("logs a reap from reapOnStartup too", async () => {
    const store = makeStore([makeTask({ status: "validation" })]);
    const logger = makeLogger();
    const reaper = makeReaper({ store, hub: makeHub(), logger, activeCardIds: new Set(), verdict: "dead" });

    await reaper.reapOnStartup();

    expect(lines(logger).some((l) => /orphan-reaper: reaped .*T-0001/.test(l))).toBe(true);
  });

  it("logs when a reap is SKIPPED because the orchestrator owns the card", async () => {
    // The silence that hid this bug cut both ways: a suppressed reap is as invisible as a fired
    // one. "I considered this card and left it alone" has to be observable too.
    const store = makeStore([makeTask({ status: "in-progress" })]);
    const logger = makeLogger();
    const reaper = makeReaper({ store, hub: makeHub(), logger, activeCardIds: new Set(["T-0001"]), verdict: "dead" });

    await reaper.sweepOnce();

    expect(lines(logger).some((l) => /orphan-reaper: .*T-0001.*(tracked|owns|owned)/i.test(l))).toBe(true);
  });

  it("emits exactly one reap line per reap", async () => {
    const store = makeStore([makeTask({ status: "in-progress" })]);
    const logger = makeLogger();
    const reaper = makeReaper({ store, hub: makeHub(), logger, activeCardIds: new Set(), verdict: "dead" });

    await reaper.sweepOnce();

    expect(lines(logger).filter((l) => /orphan-reaper: reaped/.test(l))).toHaveLength(1);
  });
});
