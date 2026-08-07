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
      await writeRunState({ runsDir, taskId: "T-0030", pid: 9999, runLogPath: path.join(runsDir, "T-0030.jsonl") });
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
      await writeRunState({ runsDir, taskId: "T-0031", pid: 9998, runLogPath: path.join(runsDir, "T-0031.jsonl") });
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
      await writeRunState({ runsDir, taskId: "T-0033", pid: undefined, runLogPath: logPath });
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
      await writeRunState({ runsDir, taskId: "T-0034", pid: 7777, runLogPath: path.join(runsDir, "T-0034.jsonl") });
      let clock = 1000;
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
      await writeRunState({ runsDir, taskId: "T-0035", pid: 7778, runLogPath: path.join(runsDir, "T-0035.jsonl") });
      let clock = 1000;
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
      let clock = 1000;
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
    let clock = 1000;
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

describe("ORPHANABLE_STATUSES", () => {
  it("contains exactly in-progress and validation", () => {
    expect([...ORPHANABLE_STATUSES].sort()).toEqual(["in-progress", "validation"]);
  });
});
