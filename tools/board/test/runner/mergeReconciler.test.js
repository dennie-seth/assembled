// T-0434 sat in `review` with #444 already merged and on develop because the merge happened
// while the board was restarting -- nothing watched for it. These tests pin the fix: a card
// whose linked PR is observed MERGED moves to `done` automatically, via either of two
// independently-sufficient recovery paths (startup reconciliation, periodic sweep), and never
// moves a card out of a status where that would be wrong.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMergeReconciler,
  reconcileCard,
  MERGEABLE_STATUSES,
  mergeReconcileEnabledFromEnv,
  mergeReconcileStartupEnabledFromEnv,
  mergeReconcileSweepEnabledFromEnv,
  mergeReconcileIntervalMsFromEnv,
  DEFAULT_MERGE_RECONCILE_INTERVAL_MS
} from "../../src/runner/mergeReconciler.js";
import { StaleWriteError } from "../../src/lib/taskStore.js";

function task(overrides = {}) {
  return {
    id: "T-0434",
    title: "t",
    status: "review",
    body: "",
    branch: "feature/T-0434",
    pr: "https://github.com/example/repo/pull/444",
    ...overrides
  };
}

function makeStore(tasks) {
  const writes = [];
  return {
    writes,
    list: vi.fn(async () => tasks.map((t) => ({ ...t }))),
    get: vi.fn(async (id) => {
      const t = tasks.find((x) => x.id === id);
      return t ? { ...t } : null;
    }),
    update: vi.fn(async (id, patch, opts = {}) => {
      const t = tasks.find((x) => x.id === id);
      if (!t) throw new Error(`not found: ${id}`);
      if (opts.expected) {
        const mismatches = Object.entries(opts.expected).filter(([key, value]) => t[key] !== value);
        if (mismatches.length > 0) {
          throw new StaleWriteError(id, opts.expected, t, mismatches.map(([key]) => key));
        }
      }
      Object.assign(t, patch);
      writes.push({ id, patch });
      return { ...t };
    })
  };
}

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeGit({ commitTaskFile = vi.fn().mockResolvedValue(true) } = {}) {
  return {
    autoCommitCardsOnCreateFromEnv: vi.fn(() => true),
    commitTaskFile
  };
}

function mergedPr({ headRefName = "feature/T-0434" } = {}) {
  return vi.fn().mockResolvedValue({
    url: "https://github.com/example/repo/pull/444",
    state: "MERGED",
    headRefName,
    number: 444
  });
}

describe("reconcileCard", () => {
  let logger;

  beforeEach(() => {
    logger = makeLogger();
  });

  it("transitions a card whose linked PR is observed MERGED to done, reading state via getPrStateFn", async () => {
    const t = task();
    const store = makeStore([t]);
    const getPrStateFn = mergedPr();

    const updated = await reconcileCard({ store, task: t, getPrStateFn, logger });

    expect(getPrStateFn).toHaveBeenCalledWith({ worktreeDir: null, prUrl: "https://github.com/example/repo/pull/444" });
    expect(updated.status).toBe("done");
    expect(store.update).toHaveBeenCalledWith(
      "T-0434",
      expect.objectContaining({ status: "done" }),
      { expected: { status: "review" } }
    );
  });

  // The single most important case: a PR closed WITHOUT merging must never be treated as a
  // completion. `state` is the only signal trusted, and GitHub reports "CLOSED" (never
  // "MERGED") for this regardless of whether a merge commit ever existed.
  it("leaves the card untouched when the PR is CLOSED with no merge commit (never auto-done)", async () => {
    const t = task();
    const store = makeStore([t]);
    const getPrStateFn = vi.fn().mockResolvedValue({
      url: "https://github.com/example/repo/pull/444",
      state: "CLOSED",
      headRefName: "feature/T-0434",
      number: 444
    });

    const updated = await reconcileCard({ store, task: t, getPrStateFn, logger });

    expect(updated).toBeNull();
    expect(store.update).not.toHaveBeenCalled();
  });

  it("leaves a draft PR (state OPEN) untouched", async () => {
    const t = task();
    const store = makeStore([t]);
    const getPrStateFn = vi.fn().mockResolvedValue({
      url: "https://github.com/example/repo/pull/444",
      state: "OPEN",
      headRefName: "feature/T-0434",
      number: 444,
      isDraft: true
    });

    const updated = await reconcileCard({ store, task: t, getPrStateFn, logger });

    expect(updated).toBeNull();
    expect(store.update).not.toHaveBeenCalled();
  });

  it("leaves a PR whose branch was deleted with no merge commit (state CLOSED) untouched", async () => {
    const t = task();
    const store = makeStore([t]);
    const getPrStateFn = vi.fn().mockResolvedValue({
      url: "https://github.com/example/repo/pull/444",
      state: "CLOSED",
      headRefName: null,
      number: 444
    });

    const updated = await reconcileCard({ store, task: t, getPrStateFn, logger });

    expect(updated).toBeNull();
    expect(store.update).not.toHaveBeenCalled();
  });

  it("does not call getPrStateFn and leaves the card untouched when it has no linked PR", async () => {
    const t = task({ pr: null });
    const store = makeStore([t]);
    const getPrStateFn = vi.fn();

    const updated = await reconcileCard({ store, task: t, getPrStateFn, logger });

    expect(updated).toBeNull();
    expect(getPrStateFn).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });

  it("leaves the card untouched and logs a reason when the PR cannot be read (API failure)", async () => {
    const t = task();
    const store = makeStore([t]);
    const getPrStateFn = vi.fn().mockRejectedValue(new Error("404: Not Found"));

    const updated = await reconcileCard({ store, task: t, getPrStateFn, logger });

    expect(updated).toBeNull();
    expect(store.update).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("could not be read"));
  });

  it("treats a PR read that exceeds the bound as unreadable, without hanging the call", async () => {
    vi.useFakeTimers();
    try {
      const t = task();
      const store = makeStore([t]);
      const getPrStateFn = vi.fn(() => new Promise(() => {})); // never resolves

      const promise = reconcileCard({ store, task: t, getPrStateFn, logger, prReadTimeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      const updated = await promise;

      expect(updated).toBeNull();
      expect(store.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports (logs) rather than completes a card whose PR is MERGED while it's still in-progress", async () => {
    const t = task({ status: "in-progress" });
    const store = makeStore([t]);
    const getPrStateFn = mergedPr();

    const updated = await reconcileCard({ store, task: t, getPrStateFn, logger });

    expect(updated).toBeNull();
    expect(store.update).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("is being reported, not auto-completed"));
  });

  it("reports rather than completes a card whose PR is MERGED while it's still in validation", async () => {
    const t = task({ status: "validation" });
    const store = makeStore([t]);
    const getPrStateFn = mergedPr();

    await reconcileCard({ store, task: t, getPrStateFn, logger });

    expect(store.update).not.toHaveBeenCalled();
  });

  it("leaves a card already done untouched (idempotent: never double-applies)", async () => {
    const t = task({ status: "done" });
    const store = makeStore([t]);
    const getPrStateFn = mergedPr();

    const updated = await reconcileCard({ store, task: t, getPrStateFn, logger });

    expect(updated).toBeNull();
    expect(store.update).not.toHaveBeenCalled();
  });

  it("leaves a card moved to retired after its PR merged untouched (keeps the human's decision)", async () => {
    const t = task({ status: "retired" });
    const store = makeStore([t]);
    const getPrStateFn = mergedPr();

    const updated = await reconcileCard({ store, task: t, getPrStateFn, logger });

    expect(updated).toBeNull();
    expect(store.update).not.toHaveBeenCalled();
  });

  it("never silently completes a requires_approval card -- stays parked in review for a human", async () => {
    const t = task({ requires_approval: true });
    const store = makeStore([t]);
    const getPrStateFn = mergedPr();

    const updated = await reconcileCard({ store, task: t, getPrStateFn, logger });

    expect(updated).toBeNull();
    expect(store.update).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("requires human approval"));
  });

  it("completes a requires_approval card that has already been approved", async () => {
    const t = task({ requires_approval: true, approved_by: "@DennieSeth", approved_at: "2026-10-01T00:00:00Z" });
    const store = makeStore([t]);
    const getPrStateFn = mergedPr();

    const updated = await reconcileCard({ store, task: t, getPrStateFn, logger });

    expect(updated.status).toBe("done");
  });

  it("leaves untouched a card whose pr field points at a PR belonging to a different card (branch mismatch)", async () => {
    const t = task({ branch: "feature/T-0434" });
    const store = makeStore([t]);
    // The PR this card links to actually belongs to a different card's branch.
    const getPrStateFn = mergedPr({ headRefName: "feature/T-0999" });

    const updated = await reconcileCard({ store, task: t, getPrStateFn, logger });

    expect(updated).toBeNull();
    expect(store.update).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("shared/misattributed PR link"));
  });

  it("does not raise a conflicting write when a human moved the card at the same moment (stale write)", async () => {
    const t = task();
    const store = makeStore([t]);
    const getPrStateFn = mergedPr();
    // Simulate the race: the card changes status between the PR read and the write.
    store.update.mockImplementationOnce(async (id, patch, opts) => {
      throw new StaleWriteError(id, opts.expected, { ...t, status: "done" }, ["status"]);
    });

    await expect(reconcileCard({ store, task: t, getPrStateFn, logger })).resolves.toBeNull();
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("skipped, no conflicting write"));
  });

  it("commits the done transition for an fs-mode card", async () => {
    const t = task();
    const store = makeStore([t]);
    const getPrStateFn = mergedPr();
    const git = makeGit();

    await reconcileCard({
      store,
      task: t,
      getPrStateFn,
      logger,
      git,
      taskStoreKind: "fs",
      repoRoot: "/repo",
      tasksDir: "/repo/tasks"
    });

    expect(git.commitTaskFile).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: "/repo", filePath: "tasks/T-0434.md" })
    );
  });

  it("never commits in db mode (no tasks/*.md file to commit)", async () => {
    const t = task();
    const store = makeStore([t]);
    const getPrStateFn = mergedPr();
    const git = makeGit();

    await reconcileCard({
      store,
      task: t,
      getPrStateFn,
      logger,
      git,
      taskStoreKind: "db",
      repoRoot: "/repo",
      tasksDir: "/repo/tasks"
    });

    expect(git.commitTaskFile).not.toHaveBeenCalled();
  });

  it("broadcasts the change over hub when a card completes", async () => {
    const t = task();
    const store = makeStore([t]);
    const getPrStateFn = mergedPr();
    const hub = { broadcast: vi.fn() };

    await reconcileCard({ store, task: t, getPrStateFn, logger, hub });

    expect(hub.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "changed", id: "T-0434" }));
  });
});

describe("MERGEABLE_STATUSES", () => {
  it("is exactly {review} -- the only status this module auto-completes from", () => {
    expect(MERGEABLE_STATUSES).toEqual(new Set(["review"]));
  });
});

describe("env var helpers", () => {
  const vars = [
    "BOARD_MERGE_RECONCILE",
    "BOARD_MERGE_RECONCILE_STARTUP",
    "BOARD_MERGE_RECONCILE_SWEEP",
    "BOARD_MERGE_RECONCILE_INTERVAL_MS"
  ];
  const originals = {};

  beforeEach(() => {
    for (const v of vars) originals[v] = process.env[v];
  });

  afterEach(() => {
    for (const v of vars) {
      if (originals[v] === undefined) delete process.env[v];
      else process.env[v] = originals[v];
    }
  });

  it.each([
    ["BOARD_MERGE_RECONCILE", mergeReconcileEnabledFromEnv],
    ["BOARD_MERGE_RECONCILE_STARTUP", mergeReconcileStartupEnabledFromEnv],
    ["BOARD_MERGE_RECONCILE_SWEEP", mergeReconcileSweepEnabledFromEnv]
  ])("%s defaults to true when unset", (name, fn) => {
    delete process.env[name];
    expect(fn()).toBe(true);
  });

  it.each([
    ["BOARD_MERGE_RECONCILE", mergeReconcileEnabledFromEnv],
    ["BOARD_MERGE_RECONCILE_STARTUP", mergeReconcileStartupEnabledFromEnv],
    ["BOARD_MERGE_RECONCILE_SWEEP", mergeReconcileSweepEnabledFromEnv]
  ])("%s is false for 0/false/off/no (any case)", (name, fn) => {
    for (const value of ["0", "false", "off", "no", "OFF"]) {
      process.env[name] = value;
      expect(fn()).toBe(false);
    }
  });

  it("mergeReconcileIntervalMsFromEnv defaults to 5 minutes when unset", () => {
    delete process.env.BOARD_MERGE_RECONCILE_INTERVAL_MS;
    expect(mergeReconcileIntervalMsFromEnv()).toBe(DEFAULT_MERGE_RECONCILE_INTERVAL_MS);
    expect(DEFAULT_MERGE_RECONCILE_INTERVAL_MS).toBe(5 * 60_000);
  });

  it("mergeReconcileIntervalMsFromEnv preserves an explicit 0 as the disable sentinel", () => {
    process.env.BOARD_MERGE_RECONCILE_INTERVAL_MS = "0";
    expect(mergeReconcileIntervalMsFromEnv()).toBe(0);
  });

  it("mergeReconcileIntervalMsFromEnv falls back to the default on garbage input", () => {
    process.env.BOARD_MERGE_RECONCILE_INTERVAL_MS = "nope";
    expect(mergeReconcileIntervalMsFromEnv()).toBe(DEFAULT_MERGE_RECONCILE_INTERVAL_MS);
  });
});

describe("createMergeReconciler — the two recovery paths are independently sufficient", () => {
  let logger;

  beforeEach(() => {
    logger = makeLogger();
  });

  it("startup reconciliation alone recovers a merge missed while the board was down (sweep disabled)", async () => {
    const t = task();
    const store = makeStore([t]);
    const getPrStateFn = mergedPr();
    const reconciler = createMergeReconciler({
      store,
      enabled: true,
      startupEnabled: true,
      sweepEnabled: false,
      getPrStateFn,
      logger
    });

    const completed = await reconciler.reconcileOnStartup();

    expect(completed).toEqual(["T-0434"]);
    expect(store.update).toHaveBeenCalledTimes(1);
  });

  it("the periodic sweep alone recovers a missed merge (startup disabled)", async () => {
    const t = task();
    const store = makeStore([t]);
    const getPrStateFn = mergedPr();
    const reconciler = createMergeReconciler({
      store,
      enabled: true,
      startupEnabled: false,
      sweepEnabled: true,
      getPrStateFn,
      logger
    });

    // Startup does nothing while sweep is disabled-at-startup-only...
    const fromStartup = await reconciler.reconcileOnStartup();
    expect(fromStartup).toEqual([]);
    expect(store.update).not.toHaveBeenCalled();

    // ...but a sweep tick (what start()'s timer calls) still recovers it.
    const fromSweep = await reconciler.sweepOnce();
    expect(fromSweep).toEqual(["T-0434"]);
  });

  it("reconcileOnStartup is a no-op when the master switch is off, even with startupEnabled true", async () => {
    const t = task();
    const store = makeStore([t]);
    const reconciler = createMergeReconciler({
      store,
      enabled: false,
      startupEnabled: true,
      getPrStateFn: mergedPr(),
      logger
    });

    const completed = await reconciler.reconcileOnStartup();

    expect(completed).toEqual([]);
    expect(store.update).not.toHaveBeenCalled();
  });

  it("ticks sweepOnce on the configured interval once started, and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const t = task();
      const store = makeStore([t]);
      const reconciler = createMergeReconciler({
        store,
        enabled: true,
        sweepEnabled: true,
        intervalMs: 1000,
        getPrStateFn: mergedPr(),
        logger
      });

      reconciler.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(store.update).toHaveBeenCalledTimes(1);

      reconciler.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(store.update).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never starts the timer when sweepEnabled is false", async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore([task()]);
      const reconciler = createMergeReconciler({
        store,
        enabled: true,
        sweepEnabled: false,
        intervalMs: 1000,
        getPrStateFn: mergedPr(),
        logger
      });

      reconciler.start();
      await vi.advanceTimersByTimeAsync(5000);

      expect(store.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a sweep tick is idempotent -- reconciling the same already-done card twice never double-applies", async () => {
    const t = task();
    const store = makeStore([t]);
    const reconciler = createMergeReconciler({
      store,
      enabled: true,
      getPrStateFn: mergedPr(),
      logger
    });

    await reconciler.sweepOnce();
    expect(store.update).toHaveBeenCalledTimes(1);

    await reconciler.sweepOnce();
    expect(store.update).toHaveBeenCalledTimes(1); // still 1 -- second pass sees status "done", no-ops
  });

  it("one card's unexpected failure does not stop the rest of the sweep from being reconciled", async () => {
    const good = task({ id: "T-0100", branch: "feature/T-0100", pr: "https://github.com/example/repo/pull/100" });
    const bad = task({ id: "T-0200", branch: "feature/T-0200", pr: "https://github.com/example/repo/pull/200" });
    const store = makeStore([bad, good]);
    const getPrStateFn = vi.fn(async ({ prUrl }) => {
      if (prUrl.endsWith("/200")) {
        return { url: prUrl, state: "MERGED", headRefName: "feature/T-0200", number: 200 };
      }
      return { url: prUrl, state: "MERGED", headRefName: "feature/T-0100", number: 100 };
    });
    store.update.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });
    const reconciler = createMergeReconciler({ store, getPrStateFn, logger });

    const completed = await reconciler.sweepOnce();

    expect(completed).toEqual(["T-0100"]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("unexpected error reconciling card T-0200"));
  });
});
