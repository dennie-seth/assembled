import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createOrphanReaper, orphanRecoveryEnabledFromEnv, ORPHANABLE_STATUSES } from "../../src/runner/orphanReaper.js";

function makeTask(overrides = {}) {
  return {
    id: "T-0001",
    title: "Some card",
    status: "in-progress",
    body: "## Context\n\nsomething\n",
    ...overrides
  };
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

function makeHub() {
  return { broadcast: vi.fn() };
}

describe("orphanRecoveryEnabledFromEnv", () => {
  const original = process.env.AUTO_RECOVER_ORPHANED_RUNS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AUTO_RECOVER_ORPHANED_RUNS;
    } else {
      process.env.AUTO_RECOVER_ORPHANED_RUNS = original;
    }
  });

  it("defaults to true when unset", () => {
    delete process.env.AUTO_RECOVER_ORPHANED_RUNS;
    expect(orphanRecoveryEnabledFromEnv()).toBe(true);
  });

  it.each(["0", "false", "off", "no", "FALSE", "Off"])("is false when set to %s", (value) => {
    process.env.AUTO_RECOVER_ORPHANED_RUNS = value;
    expect(orphanRecoveryEnabledFromEnv()).toBe(false);
  });
});

describe("reapOnStartup", () => {
  it("resets an in-progress card to blocked with a recovery note", async () => {
    const store = makeStore([makeTask({ id: "T-0001", status: "in-progress" })]);
    const hub = makeHub();
    const reaper = createOrphanReaper({ store, hub, activeCardIds: new Set(), enabled: true });

    const reaped = await reaper.reapOnStartup();

    expect(reaped).toEqual(["T-0001"]);
    const updated = store._byId.get("T-0001");
    expect(updated.status).toBe("blocked");
    expect(updated.body).toMatch(/## Recovered \(.+\)/);
    expect(updated.body).toMatch(/run did not complete \(board restarted or process ended before a verdict\); reset to blocked for re-run\./);
    expect(hub.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "changed", id: "T-0001" }));
  });

  it("resets a validation card to blocked", async () => {
    const store = makeStore([makeTask({ id: "T-0002", status: "validation" })]);
    const hub = makeHub();
    const reaper = createOrphanReaper({ store, hub, activeCardIds: new Set(), enabled: true });

    const reaped = await reaper.reapOnStartup();

    expect(reaped).toEqual(["T-0002"]);
    expect(store._byId.get("T-0002").status).toBe("blocked");
  });

  it.each(["backlog", "ready", "review", "done", "blocked", "retired"])(
    "leaves a %s card untouched",
    async (status) => {
      const store = makeStore([makeTask({ id: "T-0003", status })]);
      const hub = makeHub();
      const reaper = createOrphanReaper({ store, hub, activeCardIds: new Set(), enabled: true });

      const reaped = await reaper.reapOnStartup();

      expect(reaped).toEqual([]);
      expect(store._byId.get("T-0003").status).toBe(status);
      expect(hub.broadcast).not.toHaveBeenCalled();
    }
  );

  it("preserves the card's other fields", async () => {
    const store = makeStore([
      makeTask({ id: "T-0004", status: "in-progress", branch: "feature/T-0004", commit: "abc123", agent: "server" })
    ]);
    const hub = makeHub();
    const reaper = createOrphanReaper({ store, hub, activeCardIds: new Set(), enabled: true });

    await reaper.reapOnStartup();

    const updated = store._byId.get("T-0004");
    expect(updated.branch).toBe("feature/T-0004");
    expect(updated.commit).toBe("abc123");
    expect(updated.agent).toBe("server");
  });

  it("reaps multiple stranded cards in one pass", async () => {
    const store = makeStore([
      makeTask({ id: "T-0005", status: "in-progress" }),
      makeTask({ id: "T-0006", status: "validation" }),
      makeTask({ id: "T-0007", status: "ready" })
    ]);
    const hub = makeHub();
    const reaper = createOrphanReaper({ store, hub, activeCardIds: new Set(), enabled: true });

    const reaped = await reaper.reapOnStartup();

    expect(reaped.sort()).toEqual(["T-0005", "T-0006"]);
  });

  it("does nothing when disabled", async () => {
    const store = makeStore([makeTask({ id: "T-0008", status: "in-progress" })]);
    const hub = makeHub();
    const reaper = createOrphanReaper({ store, hub, activeCardIds: new Set(), enabled: false });

    const reaped = await reaper.reapOnStartup();

    expect(reaped).toEqual([]);
    expect(store._byId.get("T-0008").status).toBe("in-progress");
  });
});

describe("sweepOnce", () => {
  it("does not reap a card whose id is in activeCardIds", async () => {
    const store = makeStore([makeTask({ id: "T-0010", status: "in-progress" })]);
    const hub = makeHub();
    const activeCardIds = new Set(["T-0010"]);
    const reaper = createOrphanReaper({ store, hub, activeCardIds, enabled: true, graceMs: 0 });

    const reaped = await reaper.sweepOnce();

    expect(reaped).toEqual([]);
    expect(store._byId.get("T-0010").status).toBe("in-progress");
  });

  it("does not reap an orphaned card before the grace window elapses", async () => {
    const store = makeStore([makeTask({ id: "T-0011", status: "in-progress" })]);
    const hub = makeHub();
    let clock = 1000;
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds: new Set(),
      enabled: true,
      graceMs: 15_000,
      now: () => clock
    });

    const firstPass = await reaper.sweepOnce();
    expect(firstPass).toEqual([]);

    clock += 5_000;
    const secondPass = await reaper.sweepOnce();
    expect(secondPass).toEqual([]);
    expect(store._byId.get("T-0011").status).toBe("in-progress");
  });

  it("reaps an orphaned card once the grace window elapses", async () => {
    const store = makeStore([makeTask({ id: "T-0012", status: "in-progress" })]);
    const hub = makeHub();
    let clock = 1000;
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds: new Set(),
      enabled: true,
      graceMs: 15_000,
      now: () => clock
    });

    await reaper.sweepOnce();
    clock += 15_000;
    const reaped = await reaper.sweepOnce();

    expect(reaped).toEqual(["T-0012"]);
    expect(store._byId.get("T-0012").status).toBe("blocked");
  });

  it("resets the grace timer if the card becomes active again before the window elapses", async () => {
    const store = makeStore([makeTask({ id: "T-0013", status: "in-progress" })]);
    const hub = makeHub();
    const activeCardIds = new Set();
    let clock = 1000;
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds,
      enabled: true,
      graceMs: 15_000,
      now: () => clock
    });

    await reaper.sweepOnce();
    clock += 5_000;
    activeCardIds.add("T-0013");
    await reaper.sweepOnce();

    activeCardIds.delete("T-0013");
    clock += 5_000;
    const stillWithinNewGrace = await reaper.sweepOnce();
    expect(stillWithinNewGrace).toEqual([]);

    clock += 15_000;
    const reaped = await reaper.sweepOnce();
    expect(reaped).toEqual(["T-0013"]);
  });

  it("leaves ready/backlog/review/done/blocked/retired cards alone regardless of activeCardIds", async () => {
    const store = makeStore([
      makeTask({ id: "T-0014", status: "ready" }),
      makeTask({ id: "T-0015", status: "review" }),
      makeTask({ id: "T-0016", status: "done" }),
      makeTask({ id: "T-0017", status: "blocked" })
    ]);
    const hub = makeHub();
    const reaper = createOrphanReaper({ store, hub, activeCardIds: new Set(), enabled: true, graceMs: 0 });

    const reaped = await reaper.sweepOnce();

    expect(reaped).toEqual([]);
  });

  it("does nothing when disabled", async () => {
    const store = makeStore([makeTask({ id: "T-0018", status: "in-progress" })]);
    const hub = makeHub();
    const reaper = createOrphanReaper({ store, hub, activeCardIds: new Set(), enabled: false, graceMs: 0 });

    const reaped = await reaper.sweepOnce();

    expect(reaped).toEqual([]);
    expect(store._byId.get("T-0018").status).toBe("in-progress");
  });
});

describe("start/stop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweeps on the configured interval once started", async () => {
    const store = makeStore([makeTask({ id: "T-0020", status: "in-progress" })]);
    const hub = makeHub();
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds: new Set(),
      enabled: true,
      graceMs: 0,
      intervalMs: 1000
    });

    reaper.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(store._byId.get("T-0020").status).toBe("blocked");
    reaper.stop();
  });

  it("does not sweep after stop is called", async () => {
    const store = makeStore([makeTask({ id: "T-0021", status: "in-progress" })]);
    const hub = makeHub();
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds: new Set(),
      enabled: true,
      graceMs: 0,
      intervalMs: 1000
    });

    reaper.start();
    reaper.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(store._byId.get("T-0021").status).toBe("in-progress");
  });

  it("never starts the interval when disabled", async () => {
    const store = makeStore([makeTask({ id: "T-0022", status: "in-progress" })]);
    const hub = makeHub();
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds: new Set(),
      enabled: false,
      graceMs: 0,
      intervalMs: 1000
    });

    reaper.start();
    await vi.advanceTimersByTimeAsync(5000);

    expect(store._byId.get("T-0022").status).toBe("in-progress");
  });
});

describe("ORPHANABLE_STATUSES", () => {
  it("contains exactly in-progress and validation", () => {
    expect([...ORPHANABLE_STATUSES].sort()).toEqual(["in-progress", "validation"]);
  });
});
