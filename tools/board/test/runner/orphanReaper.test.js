import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrphanReaper, orphanRecoveryEnabledFromEnv, ORPHANABLE_STATUSES } from "../../src/runner/orphanReaper.js";
import { writeRunState } from "../../src/runner/runState.js";

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

function makeGit(overrides = {}) {
  return {
    commitTaskFile: vi.fn(async () => true),
    autoCommitCardsOnCreateFromEnv: vi.fn(() => true),
    ...overrides
  };
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
    let clock = Date.now();
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
    let clock = Date.now();
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
    let clock = Date.now();
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

describe("liveness check (survives a process restart)", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "orphan-reaper-liveness-"));
  });

  afterEach(async () => {
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  describe("reapOnStartup", () => {
    it("does NOT reap a card whose recorded pid is still alive, and re-adopts it into activeCardIds", async () => {
      const store = makeStore([makeTask({ id: "T-0030", status: "in-progress" })]);
      const hub = makeHub();
      const activeCardIds = new Set();
      await writeRunState({ runsDir, taskId: "T-0030", pid: 9999, runLogPath: path.join(runsDir, "T-0030.jsonl"), now: () => new Date(Date.now() - 30 * 60_000) });
      const reaper = createOrphanReaper({
        store,
        hub,
        activeCardIds,
        enabled: true,
        runsDir,
        isPidAliveFn: (pid) => pid === 9999
      });

      const reaped = await reaper.reapOnStartup();

      expect(reaped).toEqual([]);
      expect(store._byId.get("T-0030").status).toBe("in-progress");
      expect(hub.broadcast).not.toHaveBeenCalled();
      expect(activeCardIds.has("T-0030")).toBe(true);
    });

    it("reaps a card whose recorded pid is dead", async () => {
      const store = makeStore([makeTask({ id: "T-0031", status: "in-progress" })]);
      const hub = makeHub();
      await writeRunState({ runsDir, taskId: "T-0031", pid: 9998, runLogPath: path.join(runsDir, "T-0031.jsonl"), now: () => new Date(Date.now() - 30 * 60_000) });
      const reaper = createOrphanReaper({
        store,
        hub,
        activeCardIds: new Set(),
        enabled: true,
        runsDir,
        isPidAliveFn: () => false
      });

      const reaped = await reaper.reapOnStartup();

      expect(reaped).toEqual(["T-0031"]);
      expect(store._byId.get("T-0031").status).toBe("blocked");
    });

    it("reaps a card with no runstate on disk at all (pre-fix runs, or genuinely never started)", async () => {
      const store = makeStore([makeTask({ id: "T-0032", status: "in-progress" })]);
      const hub = makeHub();
      const reaper = createOrphanReaper({ store, hub, activeCardIds: new Set(), enabled: true, runsDir });

      const reaped = await reaper.reapOnStartup();

      expect(reaped).toEqual(["T-0032"]);
      expect(store._byId.get("T-0032").status).toBe("blocked");
    });

    it("does not crash and reaps when the runstate file exists but has no usable pid and a stale heartbeat", async () => {
      const store = makeStore([makeTask({ id: "T-0033", status: "validation" })]);
      const hub = makeHub();
      const logPath = path.join(runsDir, "T-0033.jsonl");
      await fs.writeFile(logPath, "{}\n", "utf8");
      await fs.utimes(logPath, new Date(Date.now() - 5 * 60_000), new Date(Date.now() - 5 * 60_000));
      await writeRunState({ runsDir, taskId: "T-0033", pid: undefined, runLogPath: logPath, now: () => new Date(Date.now() - 30 * 60_000) });
      const reaper = createOrphanReaper({ store, hub, activeCardIds: new Set(), enabled: true, runsDir });

      const reaped = await reaper.reapOnStartup();

      expect(reaped).toEqual(["T-0033"]);
    });
  });

  describe("sweepOnce", () => {
    it("does not reap an absent-from-activeCardIds card once grace elapses if its pid is still alive, and re-adopts it", async () => {
      const store = makeStore([makeTask({ id: "T-0034", status: "in-progress" })]);
      const hub = makeHub();
      const activeCardIds = new Set();
      await writeRunState({ runsDir, taskId: "T-0034", pid: 7777, runLogPath: path.join(runsDir, "T-0034.jsonl"), now: () => new Date(Date.now() - 30 * 60_000) });
      let clock = Date.now();
      const reaper = createOrphanReaper({
        store,
        hub,
        activeCardIds,
        enabled: true,
        graceMs: 15_000,
        runsDir,
        isPidAliveFn: (pid) => pid === 7777,
        now: () => clock
      });

      await reaper.sweepOnce();
      clock += 15_000;
      const reaped = await reaper.sweepOnce();

      expect(reaped).toEqual([]);
      expect(store._byId.get("T-0034").status).toBe("in-progress");
      expect(activeCardIds.has("T-0034")).toBe(true);
    });

    it("reaps once grace elapses when the recorded pid is dead", async () => {
      const store = makeStore([makeTask({ id: "T-0035", status: "in-progress" })]);
      const hub = makeHub();
      await writeRunState({ runsDir, taskId: "T-0035", pid: 7778, runLogPath: path.join(runsDir, "T-0035.jsonl"), now: () => new Date(Date.now() - 30 * 60_000) });
      let clock = Date.now();
      const reaper = createOrphanReaper({
        store,
        hub,
        activeCardIds: new Set(),
        enabled: true,
        graceMs: 15_000,
        runsDir,
        isPidAliveFn: () => false,
        now: () => clock
      });

      await reaper.sweepOnce();
      clock += 15_000;
      const reaped = await reaper.sweepOnce();

      expect(reaped).toEqual(["T-0035"]);
      expect(store._byId.get("T-0035").status).toBe("blocked");
    });

    it("does not crash when there is no runstate file for the candidate card", async () => {
      const store = makeStore([makeTask({ id: "T-0036", status: "in-progress" })]);
      const hub = makeHub();
      let clock = Date.now();
      const reaper = createOrphanReaper({
        store,
        hub,
        activeCardIds: new Set(),
        enabled: true,
        graceMs: 15_000,
        runsDir,
        now: () => clock
      });

      await reaper.sweepOnce();
      clock += 15_000;
      const reaped = await expect(reaper.sweepOnce()).resolves.toEqual(["T-0036"]);
      void reaped;
      expect(store._byId.get("T-0036").status).toBe("blocked");
    });
  });
});

// T-0289: T-0276 and T-0287 were both mis-reaped while their recorded pid was genuinely alive
// and their run log had been written to seconds earlier -- twice, with the card oscillating
// blocked -> validation -> blocked on every ~30s sweep for the rest of the run (see the card's
// human comments). A single-sweep assertion isn't enough to catch a regression here: the bug
// only shows up as a *repeated* false reap across consecutive sweeps once the run has been
// alive longer than DEFAULT_HEARTBEAT_STALE_MS. `isPidAliveFn` reporting "not alive" here stands
// in for a false negative from the real `isPidAlive` (an unexpected process.kill(2) errno) --
// the run log being written to seconds ago is the corroborating evidence that should override it.
describe("T-0287 regression: a live run with an inconclusive pid check is never reaped, across many sweeps", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "orphan-reaper-t0287-"));
  });

  afterEach(async () => {
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  it("sweepOnce never reaps across 10 consecutive sweeps when the pid check is inconclusive but the log keeps growing", async () => {
    const store = makeStore([makeTask({ id: "T-0287", status: "in-progress" })]);
    const hub = makeHub();
    const logPath = path.join(runsDir, "T-0287.jsonl");
    await fs.writeFile(logPath, "line\n", "utf8");
    await writeRunState({ runsDir, taskId: "T-0287", pid: 246322, runLogPath: logPath, now: () => new Date(Date.now() - 30 * 60_000) });
    const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
    let clock = Date.now();
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds: new Set(),
      enabled: true,
      graceMs: 15_000,
      runsDir,
      logger,
      isPidAliveFn: () => false,
      now: () => clock
    });

    for (let i = 0; i < 10; i++) {
      clock += 30_000;
      // Simulate the run log still being actively appended to on every tick.
      await fs.utimes(logPath, new Date(clock), new Date(clock));
      const reaped = await reaper.sweepOnce();
      expect(reaped).toEqual([]);
    }

    expect(store._byId.get("T-0287").status).toBe("in-progress");
    expect(hub.broadcast).not.toHaveBeenCalled();
  });

  it("reapOnStartup does not reap on a restart when the pid check is inconclusive but the log keeps growing (same rule as sweepOnce)", async () => {
    const store = makeStore([makeTask({ id: "T-0276", status: "in-progress" })]);
    const hub = makeHub();
    const logPath = path.join(runsDir, "T-0276.jsonl");
    await fs.writeFile(logPath, "line\n", "utf8");
    await writeRunState({ runsDir, taskId: "T-0276", pid: 1730227, runLogPath: logPath, now: () => new Date(Date.now() - 30 * 60_000) });
    const activeCardIds = new Set();
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds,
      enabled: true,
      runsDir,
      isPidAliveFn: () => false
    });

    const reaped = await reaper.reapOnStartup();

    expect(reaped).toEqual([]);
    expect(store._byId.get("T-0276").status).toBe("in-progress");
    // NOT re-adopted into activeCardIds -- an inconclusive pid check corroborated only by a
    // fresh log is weaker evidence than a confirmed-alive pid (see the "deferred" verdict in
    // orphanReaper.js) and must stay a recheckable candidate, not be trusted forever. The
    // previous version of this test asserted `true` here, which is exactly the correctness
    // regression VALIDATION caught: a card readopted this way is never removed from
    // activeCardIds by anything (runOrchestrator.js's own cleanup lives inside a runCard() that
    // by construction doesn't exist for a reaper-readopted card), so once its run genuinely died
    // it would be stranded at in-progress forever instead of ever becoming reapable again. See
    // the "T-0289 correctness regression" describe block below for the full round-trip.
    expect(activeCardIds.has("T-0276")).toBe(false);
  });

  it("still reaps once the run log also goes stale, even with the same inconclusive pid check -- a genuinely dead run stays reapable", async () => {
    const store = makeStore([makeTask({ id: "T-0243", status: "in-progress" })]);
    const hub = makeHub();
    const logPath = path.join(runsDir, "T-0243.jsonl");
    const staleTime = new Date(Date.now() - 5 * 60_000);
    await fs.writeFile(logPath, "line\n", "utf8");
    await fs.utimes(logPath, staleTime, staleTime);
    await writeRunState({ runsDir, taskId: "T-0243", pid: 999999, runLogPath: logPath, now: () => new Date(Date.now() - 30 * 60_000) });
    let clock = Date.now();
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds: new Set(),
      enabled: true,
      graceMs: 15_000,
      runsDir,
      isPidAliveFn: () => false,
      now: () => clock
    });

    await reaper.sweepOnce();
    clock += 15_000;
    const reaped = await reaper.sweepOnce();

    expect(reaped).toEqual(["T-0243"]);
    expect(store._byId.get("T-0243").status).toBe("blocked");
  });

  it("logs the reap decision's inputs (pid, pid-alive verdict, log age, heartbeat age) when it actually reaps a dead run", async () => {
    const store = makeStore([makeTask({ id: "T-0999", status: "in-progress" })]);
    const hub = makeHub();
    await writeRunState({ runsDir, taskId: "T-0999", pid: 55555, runLogPath: path.join(runsDir, "T-0999.jsonl"), now: () => new Date(Date.now() - 30 * 60_000) });
    const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds: new Set(),
      enabled: true,
      runsDir,
      logger,
      isPidAliveFn: () => false
    });

    await reaper.reapOnStartup();

    const loggedReapDecision = logger.log.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes("T-0999") && call[0].includes("55555")
    );
    expect(loggedReapDecision).toBe(true);
  });
});

describe("wedged-run cross-check (pid alive but run log stale — T-0185)", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "orphan-reaper-wedged-"));
  });

  afterEach(async () => {
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  async function writeStaleLog(taskId, staleMs) {
    const logPath = path.join(runsDir, `${taskId}.jsonl`);
    await fs.writeFile(logPath, "{}\n", "utf8");
    const staleTime = new Date(Date.now() - staleMs);
    await fs.utimes(logPath, staleTime, staleTime);
    return logPath;
  }

  describe("reapOnStartup", () => {
    it("kills the process group and reaps a card whose pid is alive but whose run log has gone stale", async () => {
      const store = makeStore([makeTask({ id: "T-0050", status: "in-progress" })]);
      const hub = makeHub();
      const logPath = await writeStaleLog("T-0050", 60 * 60_000);
      await writeRunState({ runsDir, taskId: "T-0050", pid: 12345, runLogPath: logPath, now: () => new Date(Date.now() - 30 * 60_000) });
      const killPidGroupFn = vi.fn(async () => {});
      const reaper = createOrphanReaper({
        store,
        hub,
        activeCardIds: new Set(),
        enabled: true,
        runsDir,
        isPidAliveFn: (pid) => pid === 12345,
        wedgedStaleMs: 45 * 60_000,
        killPidGroupFn
      });

      const reaped = await reaper.reapOnStartup();

      expect(reaped).toEqual(["T-0050"]);
      expect(store._byId.get("T-0050").status).toBe("blocked");
      expect(store._byId.get("T-0050").body).toMatch(/wedge|stale|hung/i);
      expect(killPidGroupFn).toHaveBeenCalledWith(expect.objectContaining({ pid: 12345 }));
    });

    it("does NOT treat a pid-alive card as wedged when its run log is still fresh, and re-adopts it", async () => {
      const store = makeStore([makeTask({ id: "T-0051", status: "in-progress" })]);
      const hub = makeHub();
      const logPath = await writeStaleLog("T-0051", 1000);
      await writeRunState({ runsDir, taskId: "T-0051", pid: 12346, runLogPath: logPath, now: () => new Date(Date.now() - 30 * 60_000) });
      const killPidGroupFn = vi.fn(async () => {});
      const activeCardIds = new Set();
      const reaper = createOrphanReaper({
        store,
        hub,
        activeCardIds,
        enabled: true,
        runsDir,
        isPidAliveFn: (pid) => pid === 12346,
        wedgedStaleMs: 45 * 60_000,
        killPidGroupFn
      });

      const reaped = await reaper.reapOnStartup();

      expect(reaped).toEqual([]);
      expect(store._byId.get("T-0051").status).toBe("in-progress");
      expect(killPidGroupFn).not.toHaveBeenCalled();
      expect(activeCardIds.has("T-0051")).toBe(true);
    });
  });

  describe("sweepOnce", () => {
    it("kills and reaps an absent-from-activeCardIds wedged card once grace elapses", async () => {
      const store = makeStore([makeTask({ id: "T-0052", status: "validation" })]);
      const hub = makeHub();
      const logPath = await writeStaleLog("T-0052", 60 * 60_000);
      await writeRunState({ runsDir, taskId: "T-0052", pid: 12347, runLogPath: logPath, now: () => new Date(Date.now() - 30 * 60_000) });
      const killPidGroupFn = vi.fn(async () => {});
      // Starts from a real epoch timestamp (not a small fake-clock offset like other tests
      // here use) since isRunWedged compares this `now()` against the log file's *real*
      // mtime -- mixing a tiny fake clock with a real mtime would make every staleness check
      // spuriously see a huge (or negative) gap.
      let clock = Date.now();
      const reaper = createOrphanReaper({
        store,
        hub,
        activeCardIds: new Set(),
        enabled: true,
        graceMs: 15_000,
        runsDir,
        isPidAliveFn: (pid) => pid === 12347,
        wedgedStaleMs: 45 * 60_000,
        killPidGroupFn,
        now: () => clock
      });

      await reaper.sweepOnce();
      clock += 15_000;
      const reaped = await reaper.sweepOnce();

      expect(reaped).toEqual(["T-0052"]);
      expect(store._byId.get("T-0052").status).toBe("blocked");
      expect(killPidGroupFn).toHaveBeenCalledWith(expect.objectContaining({ pid: 12347 }));
    });

    it(
      "kills (but does NOT reap/reset status) a wedged card that IS still tracked in activeCardIds -- " +
        "the T-0185 root cause: a live board process's own runCard() must finish handling the card once the kill lands",
      async () => {
        const store = makeStore([makeTask({ id: "T-0053", status: "validation" })]);
        const hub = makeHub();
        const logPath = await writeStaleLog("T-0053", 60 * 60_000);
        await writeRunState({ runsDir, taskId: "T-0053", pid: 12348, runLogPath: logPath, now: () => new Date(Date.now() - 30 * 60_000) });
        const killPidGroupFn = vi.fn(async () => {});
        const activeCardIds = new Set(["T-0053"]);
        const reaper = createOrphanReaper({
          store,
          hub,
          activeCardIds,
          enabled: true,
          runsDir,
          isPidAliveFn: (pid) => pid === 12348,
          wedgedStaleMs: 45 * 60_000,
          killPidGroupFn
        });

        const reaped = await reaper.sweepOnce();

        expect(reaped).toEqual([]);
        expect(store._byId.get("T-0053").status).toBe("validation");
        expect(hub.broadcast).not.toHaveBeenCalled();
        expect(killPidGroupFn).toHaveBeenCalledWith(expect.objectContaining({ pid: 12348 }));
        expect(activeCardIds.has("T-0053")).toBe(true);
      }
    );

    it("does NOT kill an activeCardIds-tracked card whose run log is still fresh (not wedged)", async () => {
      const store = makeStore([makeTask({ id: "T-0054", status: "validation" })]);
      const hub = makeHub();
      const logPath = await writeStaleLog("T-0054", 1000);
      await writeRunState({ runsDir, taskId: "T-0054", pid: 12349, runLogPath: logPath, now: () => new Date(Date.now() - 30 * 60_000) });
      const killPidGroupFn = vi.fn(async () => {});
      const activeCardIds = new Set(["T-0054"]);
      const reaper = createOrphanReaper({
        store,
        hub,
        activeCardIds,
        enabled: true,
        runsDir,
        isPidAliveFn: (pid) => pid === 12349,
        wedgedStaleMs: 45 * 60_000,
        killPidGroupFn
      });

      await reaper.sweepOnce();

      expect(killPidGroupFn).not.toHaveBeenCalled();
      expect(store._byId.get("T-0054").status).toBe("validation");
    });

    it("does not attempt to kill anything when the card is not in activeCardIds and its pid is simply dead (existing dead-pid path, unaffected)", async () => {
      const store = makeStore([makeTask({ id: "T-0055", status: "in-progress" })]);
      const hub = makeHub();
      await writeRunState({ runsDir, taskId: "T-0055", pid: 12350, runLogPath: path.join(runsDir, "T-0055.jsonl"), now: () => new Date(Date.now() - 30 * 60_000) });
      const killPidGroupFn = vi.fn(async () => {});
      let clock = Date.now();
      const reaper = createOrphanReaper({
        store,
        hub,
        activeCardIds: new Set(),
        enabled: true,
        graceMs: 15_000,
        runsDir,
        isPidAliveFn: () => false,
        killPidGroupFn,
        now: () => clock
      });

      await reaper.sweepOnce();
      clock += 15_000;
      const reaped = await reaper.sweepOnce();

      expect(reaped).toEqual(["T-0055"]);
      expect(killPidGroupFn).not.toHaveBeenCalled();
    });
  });
});

describe("reapCard commits its status write to repoRoot", () => {
  // Regression coverage: recovery (reapOnStartup/sweepOnce) used to call `store.update()`
  // without committing, leaving repoRoot's working tree dirty exactly like the in-run status
  // flips in runOrchestrator.js -- the next Done-triggered pullDevelop would abort with
  // "local changes would be overwritten by merge" the moment origin touched the same card.
  // Opt-in via repoRoot/tasksDir: omitting them (as the tests above all do) disables
  // committing entirely, matching httpApi.js's `if (repoRoot && tasksDir && ...)` guard.

  it("reapOnStartup commits the recovered card via git.commitTaskFile when repoRoot/tasksDir are configured", async () => {
    const store = makeStore([makeTask({ id: "T-0040", status: "in-progress" })]);
    const hub = makeHub();
    const git = makeGit();
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds: new Set(),
      enabled: true,
      repoRoot: "/repo",
      tasksDir: "/repo/tasks",
      git
    });

    const reaped = await reaper.reapOnStartup();

    expect(reaped).toEqual(["T-0040"]);
    expect(git.commitTaskFile).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/repo",
        filePath: "tasks/T-0040.md",
        message: expect.stringContaining("T-0040")
      })
    );
  });

  it("sweepOnce commits the recovered card via git.commitTaskFile once grace elapses", async () => {
    const store = makeStore([makeTask({ id: "T-0041", status: "in-progress" })]);
    const hub = makeHub();
    const git = makeGit();
    let clock = Date.now();
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds: new Set(),
      enabled: true,
      graceMs: 15_000,
      now: () => clock,
      repoRoot: "/repo",
      tasksDir: "/repo/tasks",
      git
    });

    await reaper.sweepOnce();
    clock += 15_000;
    const reaped = await reaper.sweepOnce();

    expect(reaped).toEqual(["T-0041"]);
    expect(git.commitTaskFile).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: "/repo", filePath: "tasks/T-0041.md" })
    );
  });

  it("does not attempt to commit when repoRoot/tasksDir are not configured (existing test default)", async () => {
    const store = makeStore([makeTask({ id: "T-0042", status: "in-progress" })]);
    const hub = makeHub();
    const git = makeGit();
    const reaper = createOrphanReaper({ store, hub, activeCardIds: new Set(), enabled: true, git });

    await reaper.reapOnStartup();

    expect(git.commitTaskFile).not.toHaveBeenCalled();
  });

  it("does not skip the reap or crash the sweep when git.commitTaskFile rejects", async () => {
    const store = makeStore([makeTask({ id: "T-0043", status: "in-progress" })]);
    const hub = makeHub();
    const git = makeGit({ commitTaskFile: vi.fn(async () => { throw new Error("index.lock exists"); }) });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds: new Set(),
      enabled: true,
      repoRoot: "/repo",
      tasksDir: "/repo/tasks",
      git
    });

    const reaped = await reaper.reapOnStartup();

    expect(reaped).toEqual(["T-0043"]);
    expect(store._byId.get("T-0043").status).toBe("blocked");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips committing when git.autoCommitCardsOnCreateFromEnv() reports the flag disabled", async () => {
    const store = makeStore([makeTask({ id: "T-0044", status: "in-progress" })]);
    const hub = makeHub();
    const git = makeGit({ autoCommitCardsOnCreateFromEnv: vi.fn(() => false) });
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds: new Set(),
      enabled: true,
      repoRoot: "/repo",
      tasksDir: "/repo/tasks",
      git
    });

    await reaper.reapOnStartup();

    expect(git.commitTaskFile).not.toHaveBeenCalled();
  });

  it("skips committing in db mode even when repoRoot/tasksDir are configured -- card state lives only in SQLite", async () => {
    const store = makeStore([makeTask({ id: "T-0045", status: "in-progress" })]);
    const hub = makeHub();
    const git = makeGit();
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds: new Set(),
      enabled: true,
      repoRoot: "/repo",
      tasksDir: "/repo/tasks",
      git,
      taskStoreKind: "db"
    });

    const reaped = await reaper.reapOnStartup();

    expect(reaped).toEqual(["T-0045"]);
    expect(store._byId.get("T-0045").status).toBe("blocked");
    expect(git.commitTaskFile).not.toHaveBeenCalled();
    // The reap itself still broadcasts, unaffected by taskStoreKind -- db mode's board refresh
    // never depended on the commit in the first place.
    expect(hub.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "changed", id: "T-0045" }));
  });
});

// T-0289 VALIDATION FAIL #1 (correctness regression): the first pass at this fix treated any
// pid-not-confirmed-alive + fresh-log combination as fully "alive" and readopted it into
// activeCardIds forever. Nothing ever removes a readopted card from that Set except
// runOrchestrator.js's own runCard() cleanup, which by construction never runs for a card this
// process didn't itself spawn -- so a run that was only ever *presumed* alive (never confirmed by
// a real pid check) and later genuinely died would be stranded at in-progress/validation forever,
// pinning hasActiveRuns() true and wedging the auto-launch poller, auto-pull, and the restart
// coordinator. These tests pin the corrected behavior: a pid-inconclusive-but-log-fresh verdict
// ("deferred") is neither reaped nor permanently trusted -- it stays a re-checkable candidate
// until either the pid is confirmed alive (promotes to "alive", now safe to trust) or the log
// goes stale too (demotes to "dead", reaped like any other genuinely dead run).
describe("T-0289 correctness regression: an inconclusive pid check must stay re-checkable, never trusted forever", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "orphan-reaper-deferred-"));
  });

  afterEach(async () => {
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  it("sweepOnce defers (does not reap, does not readopt) while the log stays fresh, then reaps once the log actually goes stale", async () => {
    const store = makeStore([makeTask({ id: "T-0060", status: "in-progress" })]);
    const hub = makeHub();
    const logPath = path.join(runsDir, "T-0060.jsonl");
    await fs.writeFile(logPath, "line\n", "utf8");
    await writeRunState({ runsDir, taskId: "T-0060", pid: 424242, runLogPath: logPath, now: () => new Date(Date.now() - 30 * 60_000) });
    const activeCardIds = new Set();
    let clock = Date.now();
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds,
      enabled: true,
      graceMs: 15_000,
      runsDir,
      isPidAliveFn: () => false,
      now: () => clock
    });

    // Several sweeps while the log keeps getting touched -- deferred every time, never readopted.
    for (let i = 0; i < 5; i++) {
      clock += 30_000;
      await fs.utimes(logPath, new Date(clock), new Date(clock));
      const reaped = await reaper.sweepOnce();
      expect(reaped).toEqual([]);
      expect(activeCardIds.has("T-0060")).toBe(false);
    }
    expect(store._byId.get("T-0060").status).toBe("in-progress");

    // The run actually dies: the log stops moving. Once it's stale, the same card must become
    // reapable again -- this is the round-trip the regression broke (a readopted card never got
    // this second chance).
    clock += 120_000;
    const reaped = await reaper.sweepOnce();

    expect(reaped).toEqual(["T-0060"]);
    expect(store._byId.get("T-0060").status).toBe("blocked");
  });

  it("reapOnStartup's deferred cards flow into sweepOnce's normal orphan-candidate grace window instead of being readopted", async () => {
    const store = makeStore([makeTask({ id: "T-0061", status: "validation" })]);
    const hub = makeHub();
    const logPath = path.join(runsDir, "T-0061.jsonl");
    await fs.writeFile(logPath, "line\n", "utf8");
    await writeRunState({ runsDir, taskId: "T-0061", pid: 434343, runLogPath: logPath, now: () => new Date(Date.now() - 30 * 60_000) });
    const activeCardIds = new Set();
    let clock = Date.now();
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds,
      enabled: true,
      graceMs: 15_000,
      runsDir,
      isPidAliveFn: () => false,
      now: () => clock
    });

    const startupReaped = await reaper.reapOnStartup();
    expect(startupReaped).toEqual([]);
    expect(activeCardIds.has("T-0061")).toBe(false);
    expect(store._byId.get("T-0061").status).toBe("validation");

    // The card is absent from activeCardIds and still validation -- sweepOnce must pick it up as
    // an orphan candidate (its own grace window, freshly started), not silently ignore it.
    await fs.utimes(logPath, new Date(clock), new Date(clock));
    const firstSweep = await reaper.sweepOnce();
    expect(firstSweep).toEqual([]);

    clock += 20_000;
    await fs.utimes(logPath, new Date(clock - 500), new Date(clock - 500));
    const secondSweep = await reaper.sweepOnce();
    expect(secondSweep).toEqual([]);
    expect(store._byId.get("T-0061").status).toBe("validation");
  });

  it("a card readopted after a confirmed-alive pid check is still reaped if that run is later found fully dead (activeCardIds cleanup backstop)", async () => {
    const store = makeStore([makeTask({ id: "T-0062", status: "in-progress" })]);
    const hub = makeHub();
    const logPath = path.join(runsDir, "T-0062.jsonl");
    await fs.writeFile(logPath, "line\n", "utf8");
    await writeRunState({ runsDir, taskId: "T-0062", pid: 444444, runLogPath: logPath, now: () => new Date(Date.now() - 30 * 60_000) });
    const activeCardIds = new Set();
    let pidAlive = true;
    let clock = Date.now();
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds,
      enabled: true,
      graceMs: 15_000,
      runsDir,
      isPidAliveFn: () => pidAlive,
      now: () => clock
    });

    // A genuinely alive pid at startup is legitimately readopted -- this is not the regression.
    const startupReaped = await reaper.reapOnStartup();
    expect(startupReaped).toEqual([]);
    expect(activeCardIds.has("T-0062")).toBe(true);

    // The process dies with no runCard() in this process tracking it (it was readopted, not
    // spawned here) -- nothing else will ever notice unless sweepOnce's active-card cross-check
    // does. Once its pid is confirmed dead and its log has also gone stale, it must be reaped,
    // not left stranded in activeCardIds forever.
    pidAlive = false;
    clock += 5 * 60_000;
    const reaped = await reaper.sweepOnce();

    expect(reaped).toEqual(["T-0062"]);
    expect(store._byId.get("T-0062").status).toBe("blocked");
    expect(activeCardIds.has("T-0062")).toBe(false);
  });

  // Second VALIDATION FAIL: the activeCardIds cleanup backstop above (test T-0062) fired on
  // *any* "dead" verdict for a card in activeCardIds, not only one this module itself readopted.
  // A card added to activeCardIds by a genuine runCard() span (runOrchestrator.js) already has
  // its own exit path and must be left alone by this backstop -- even during the normal quiet
  // window between per-phase writeRunState calls, where the on-disk runstate can transiently
  // hold a since-exited child's pid (e.g. mid PR-open, which can legitimately run past
  // DEFAULT_HEARTBEAT_STALE_MS -- see T-0287) alongside a log that hasn't been touched in a
  // while either. Reaping here would be the exact false-reap-of-a-live-run failure mode this
  // whole card exists to fix, just reached through the backstop instead of the main sweep path.
  it("does not touch a card's status via the backstop when it was added to activeCardIds directly (not via readopt), even with a dead pid and a stale log", async () => {
    const store = makeStore([makeTask({ id: "T-0063", status: "in-progress" })]);
    const hub = makeHub();
    const logPath = path.join(runsDir, "T-0063.jsonl");
    await fs.writeFile(logPath, "line\n", "utf8");
    await writeRunState({ runsDir, taskId: "T-0063", pid: 454545, runLogPath: logPath, now: () => new Date(Date.now() - 30 * 60_000) });
    const staleTime = new Date(Date.now() - 5 * 60_000);
    await fs.utimes(logPath, staleTime, staleTime);
    // Simulates runOrchestrator.js's own runCard() adding the card -- never went through this
    // module's readopt(), so it must not be in readoptedCardIds.
    const activeCardIds = new Set(["T-0063"]);
    const reaper = createOrphanReaper({
      store,
      hub,
      activeCardIds,
      enabled: true,
      graceMs: 15_000,
      runsDir,
      isPidAliveFn: () => false
    });

    const reaped = await reaper.sweepOnce();

    expect(reaped).toEqual([]);
    expect(store._byId.get("T-0063").status).toBe("in-progress");
    expect(activeCardIds.has("T-0063")).toBe(true);
  });
});

// T-0289 VALIDATION FAIL #3: candidate #2 from the card's own list ("the runstate being
// unreadable or mid-write when the sweep read it") was never actually covered -- readRunState
// (see runState.js) returns null uniformly for "file missing", "unreadable", and "malformed", and
// the pre-fix code treated a null state as unconditionally dead with no corroboration, since
// state.runLogPath isn't available when state itself is null. runLog.js names every run log
// deterministically (`${taskId}-<timestamp>.jsonl`), so the run log can still be found and used
// as corroborating evidence even when the runstate file itself can't be trusted.
describe("T-0289: a missing/malformed runstate file still corroborates against the run log by taskId prefix", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "orphan-reaper-null-state-"));
  });

  afterEach(async () => {
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  it("does not reap when the runstate file is malformed JSON but a recently-touched run log for the same taskId exists", async () => {
    const store = makeStore([makeTask({ id: "T-0070", status: "in-progress" })]);
    const hub = makeHub();
    await fs.writeFile(path.join(runsDir, "T-0070.runstate.json"), "{not valid json", "utf8");
    const logPath = path.join(runsDir, "T-0070-2026-09-03T08-15-00-000Z.jsonl");
    await fs.writeFile(logPath, "line\n", "utf8");
    const activeCardIds = new Set();
    const reaper = createOrphanReaper({ store, hub, activeCardIds, enabled: true, runsDir });

    const reaped = await reaper.reapOnStartup();

    expect(reaped).toEqual([]);
    expect(store._byId.get("T-0070").status).toBe("in-progress");
    // Corroborated only by the log, not a confirmed pid -- same "deferred" rule as everywhere
    // else, so it must not be permanently readopted either.
    expect(activeCardIds.has("T-0070")).toBe(false);
  });

  it("still reaps when the runstate file is malformed AND no matching run log exists (no corroborating evidence at all)", async () => {
    const store = makeStore([makeTask({ id: "T-0071", status: "in-progress" })]);
    const hub = makeHub();
    await fs.writeFile(path.join(runsDir, "T-0071.runstate.json"), "{not valid json", "utf8");
    const reaper = createOrphanReaper({ store, hub, activeCardIds: new Set(), enabled: true, runsDir });

    const reaped = await reaper.reapOnStartup();

    expect(reaped).toEqual(["T-0071"]);
    expect(store._byId.get("T-0071").status).toBe("blocked");
  });

  it("still reaps when the runstate file is malformed and the only matching run log is stale", async () => {
    const store = makeStore([makeTask({ id: "T-0072", status: "in-progress" })]);
    const hub = makeHub();
    await fs.writeFile(path.join(runsDir, "T-0072.runstate.json"), "{not valid json", "utf8");
    const logPath = path.join(runsDir, "T-0072-2026-09-01T00-00-00-000Z.jsonl");
    await fs.writeFile(logPath, "line\n", "utf8");
    const staleTime = new Date(Date.now() - 5 * 60_000);
    await fs.utimes(logPath, staleTime, staleTime);
    const reaper = createOrphanReaper({ store, hub, activeCardIds: new Set(), enabled: true, runsDir });

    const reaped = await reaper.reapOnStartup();

    expect(reaped).toEqual(["T-0072"]);
    expect(store._byId.get("T-0072").status).toBe("blocked");
  });
});

describe("ORPHANABLE_STATUSES", () => {
  it("contains exactly in-progress and validation", () => {
    expect([...ORPHANABLE_STATUSES].sort()).toEqual(["in-progress", "validation"]);
  });
});
