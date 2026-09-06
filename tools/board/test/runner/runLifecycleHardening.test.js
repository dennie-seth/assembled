import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { RunOrchestrator } from "../../src/runner/runOrchestrator.js";
import { isRunLive } from "../../src/runner/runState.js";

/**
 * Run-lifecycle hardening -- fix-plan items #3, #4, #7 and the unpushed-on-FAIL data loss from
 * docs/reviews/2026-09-03-run-lifecycle-state-management.md.
 */

const IMPLEMENTER_DEF = { name: "infra", model: "sonnet", body: "# infra\nImplements." };
const REVIEWER_DEF = { name: "reviewer", model: "opus", body: "# reviewer\nRead-only." };

function fakeChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.pid = 4242;
  child.kill = vi.fn(() => queueMicrotask(() => child.emit("exit", null, "SIGTERM")));
  return child;
}

function makeStore(initialTasks) {
  const tasks = new Map(initialTasks.map((t) => [t.id, { ...t }]));
  return {
    tasks,
    async get(id) {
      return tasks.has(id) ? { ...tasks.get(id) } : null;
    },
    async update(id, updates) {
      const merged = { ...tasks.get(id), ...updates, id };
      tasks.set(id, merged);
      return { ...merged };
    }
  };
}

const makeRunLog = () => ({ events: [], async append() {}, close: vi.fn(async () => {}), path: "/repo/tasks/.runs/T-0001-x.jsonl" });

function baseTask(overrides = {}) {
  return {
    id: "T-0001",
    title: "Do the thing",
    status: "ready",
    priority: "P1",
    phase: 2,
    agent: "infra",
    depends_on: [],
    created: "2026-08-01",
    body: "## Context\nDo it.\n\n## Acceptance\n- [ ] works\n",
    ...overrides
  };
}

function makeGit(overrides = {}) {
  return {
    addWorktree: vi.fn(async () => {}),
    removeWorktree: vi.fn(async () => {}),
    diffNames: vi.fn(async () => ["tools/board/src/thing.js"]),
    commitAll: vi.fn(async () => true),
    push: vi.fn(async () => {}),
    getHeadCommit: vi.fn(async () => "abc1234"),
    linkBoardNodeModules: vi.fn(async () => {}),
    commitTaskFile: vi.fn(async () => true),
    autoCommitCardsOnCreateFromEnv: vi.fn(() => true),
    fetch: vi.fn(async () => {}),
    mergeDevelop: vi.fn(async () => ({ conflicted: false, changed: false })),
    mergeStatus: vi.fn(async () => []),
    hasUncommittedChanges: vi.fn(async () => false),
    ...overrides
  };
}

function makeRunner() {
  const spawnedChildren = [];
  const start = vi.fn(async () => {
    const child = fakeChildProcess();
    spawnedChildren.push(child);
    return { runId: "run", child };
  });
  return { start, kill: vi.fn((run) => run.child.kill()), spawnedChildren };
}

function makeOrchestrator({ store, git, runner, ...overrides } = {}) {
  return new RunOrchestrator({
    store,
    hub: { broadcast: vi.fn() },
    runner,
    git,
    github: { checkAvailability: vi.fn(async () => ({ available: false, reason: "not-installed" })) },
    repoRoot: "/repo",
    worktreesDir: "/repo/worktrees",
    runsDir: "/repo/tasks/.runs",
    agentsDir: "/repo/.claude/agents",
    rulesDir: "/repo/.claude/rules",
    loadAgentDefFn: (n) => (n === "reviewer" ? REVIEWER_DEF : IMPLEMENTER_DEF),
    loadRulesFn: () => [{ name: "conduct", paths: ["**"], body: "TDD." }],
    resolveAllowedToolsFn: () => ["Read"],
    createRunLogFn: vi.fn(async () => makeRunLog()),
    crossCheckVerdictFn: ({ verdict }) => verdict,
    writeRunStateFn: vi.fn(async () => {}),
    clearRunStateFn: vi.fn(async () => {}),
    ...overrides
  });
}

/** Drives a run whose implementer child crashes immediately -- the shortest terminal non-PASS. */
async function runUntilCrash(orchestrator, runner) {
  const p = orchestrator.runCard("T-0001");
  await vi.waitFor(() => expect(runner.start).toHaveBeenCalledTimes(1));
  runner.spawnedChildren[0].emit("exit", 1, null);
  await p;
}

describe("#4 the card is in-progress before worktree setup, not after", () => {
  it("writes status in-progress BEFORE addWorktree runs", async () => {
    const store = makeStore([baseTask()]);
    let statusAtWorktreeTime = null;
    const git = makeGit({
      addWorktree: vi.fn(async () => {
        statusAtWorktreeTime = store.tasks.get("T-0001").status;
      })
    });
    const runner = makeRunner();
    await runUntilCrash(makeOrchestrator({ store, git, runner }), runner);

    // Previously "ready": the card was in activeCardIds but still displayed as launchable,
    // which is exactly what defeats the auto-launch poller's second idle condition.
    expect(statusAtWorktreeTime).toBe("in-progress");
  });

  it("never leaves the card at ready once the run is tracked", async () => {
    const store = makeStore([baseTask()]);
    const seen = [];
    const git = makeGit({
      addWorktree: vi.fn(async () => seen.push(store.tasks.get("T-0001").status)),
      linkBoardNodeModules: vi.fn(async () => seen.push(store.tasks.get("T-0001").status))
    });
    const runner = makeRunner();
    await runUntilCrash(makeOrchestrator({ store, git, runner }), runner);

    expect(seen).not.toContain("ready");
  });
});

describe("#3 a live run never looks dead between phases", () => {
  it("isRunLive treats a fresh heartbeat as evidence of life even with a dead pid and a quiet log", async () => {
    const now = Date.now();
    const live = await isRunLive({
      state: { pid: 999, runLogPath: "/runs/x.jsonl", updatedAt: new Date(now - 5_000).toISOString() },
      now,
      isPidAliveFn: () => false,
      statFn: async () => ({ mtimeMs: now - 120_000 })
    });
    expect(live).toBe(true);
  });

  it("does NOT treat a stale heartbeat as life -- a genuinely dead run stays reapable", async () => {
    const now = Date.now();
    const live = await isRunLive({
      state: { pid: 999, runLogPath: "/runs/x.jsonl", updatedAt: new Date(now - 600_000).toISOString() },
      now,
      isPidAliveFn: () => false,
      statFn: async () => ({ mtimeMs: now - 600_000 })
    });
    expect(live).toBe(false);
  });

  it("refreshes the runstate on a timer across the whole runCard span, not once per phase", async () => {
    const store = makeStore([baseTask()]);
    const runner = makeRunner();
    const writeRunStateFn = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({
      store,
      git: makeGit(),
      runner,
      writeRunStateFn,
      heartbeatIntervalMs: 5
    });

    const p = orchestrator.runCard("T-0001");
    await vi.waitFor(() => expect(runner.start).toHaveBeenCalledTimes(1));
    // One phase, held open: any additional writes can only come from the heartbeat.
    await vi.waitFor(() => expect(writeRunStateFn.mock.calls.length).toBeGreaterThan(2), { timeout: 2000 });
    runner.spawnedChildren[0].emit("exit", 1, null);
    await p;
  });

  it("stops the heartbeat when the run ends", async () => {
    const store = makeStore([baseTask()]);
    const runner = makeRunner();
    const writeRunStateFn = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({ store, git: makeGit(), runner, writeRunStateFn, heartbeatIntervalMs: 5 });

    await runUntilCrash(orchestrator, runner);
    const afterRun = writeRunStateFn.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(writeRunStateFn.mock.calls.length).toBe(afterRun);
  });
});

describe("#7 the runstate does not linger after a run ends", () => {
  it("clears the runstate when a run ends abnormally (implementer crash)", async () => {
    const store = makeStore([baseTask()]);
    const runner = makeRunner();
    const clearRunStateFn = vi.fn(async () => {});
    await runUntilCrash(makeOrchestrator({ store, git: makeGit(), runner, clearRunStateFn }), runner);

    expect(clearRunStateFn).toHaveBeenCalledWith(expect.objectContaining({ taskId: "T-0001" }));
  });

  it("clears the runstate even when worktree creation fails before any phase starts", async () => {
    const store = makeStore([baseTask()]);
    const clearRunStateFn = vi.fn(async () => {});
    const git = makeGit({ addWorktree: vi.fn(async () => { throw new Error("worktree boom"); }) });
    await makeOrchestrator({ store, git, runner: makeRunner(), clearRunStateFn }).runCard("T-0001");

    expect(store.tasks.get("T-0001").status).toBe("blocked");
    expect(clearRunStateFn).toHaveBeenCalledWith(expect.objectContaining({ taskId: "T-0001" }));
  });
});

describe("unpushed-on-FAIL: committed work is never stranded in a worktree", () => {
  it("pushes the branch on a terminal non-PASS outcome", async () => {
    const store = makeStore([baseTask()]);
    const runner = makeRunner();
    const git = makeGit();
    await runUntilCrash(makeOrchestrator({ store, git, runner }), runner);

    expect(store.tasks.get("T-0001").status).toBe("blocked");
    expect(git.push).toHaveBeenCalledWith(expect.objectContaining({ branch: "feature/T-0001" }));
  });

  it("a push failure never changes the run's outcome -- preservation is best-effort", async () => {
    const store = makeStore([baseTask()]);
    const runner = makeRunner();
    const git = makeGit({ push: vi.fn(async () => { throw new Error("no remote"); }) });
    await runUntilCrash(makeOrchestrator({ store, git, runner }), runner);

    // Still blocked for the real reason, not re-blocked for the push, and no unhandled rejection.
    expect(store.tasks.get("T-0001").status).toBe("blocked");
    expect(store.tasks.get("T-0001").body).toMatch(/## Blocked/);
  });

  it("does not push when worktree creation never produced a branch", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit({ addWorktree: vi.fn(async () => { throw new Error("worktree boom"); }) });
    await makeOrchestrator({ store, git, runner: makeRunner() }).runCard("T-0001");

    expect(git.push).not.toHaveBeenCalled();
  });

  it("does not push when the branch carries no commits ahead of develop -- the empty-diff case (T-0288's 'no commits on branch' block)", async () => {
    const store = makeStore([baseTask()]);
    const runner = makeRunner();
    const git = makeGit({ diffNames: vi.fn(async () => []) });
    await runUntilCrash(makeOrchestrator({ store, git, runner }), runner);

    expect(store.tasks.get("T-0001").status).toBe("blocked");
    expect(git.push).not.toHaveBeenCalled();
  });

  it("a diffNames failure during the preservation check degrades to a log line, same as a push failure", async () => {
    const store = makeStore([baseTask()]);
    const runner = makeRunner();
    const git = makeGit({ diffNames: vi.fn(async () => { throw new Error("git diff boom"); }) });
    await runUntilCrash(makeOrchestrator({ store, git, runner }), runner);

    expect(store.tasks.get("T-0001").status).toBe("blocked");
    expect(store.tasks.get("T-0001").body).toMatch(/## Blocked/);
  });
});

describe("#7 a reap clears the runstate it just invalidated", () => {
  it("removes the stale record when the reaper concludes a run is over", async () => {
    const { createOrphanReaper } = await import("../../src/runner/orphanReaper.js");
    const tasks = new Map([["T-0001", { id: "T-0001", status: "in-progress", body: "x" }]]);
    const store = {
      async list() { return [...tasks.values()]; },
      async update(id, patch) { const u = { ...tasks.get(id), ...patch }; tasks.set(id, u); return u; }
    };
    const clearRunStateFn = vi.fn(async () => {});
    const reaper = createOrphanReaper({
      store,
      hub: { broadcast: vi.fn() },
      activeCardIds: new Set(),
      enabled: true,
      runsDir: "/runs",
      graceMs: 0,
      logger: { log: vi.fn(), error: vi.fn() },
      isRunLiveFn: async () => false,
      isPidAliveFn: () => false,
      isRunWedgedFn: async () => false,
      readRunStateFn: async () => ({ pid: 999, runLogPath: "/runs/x.jsonl", updatedAt: new Date(0).toISOString() }),
      statFn: async () => ({ mtimeMs: 0 }),
      clearRunStateFn
    });

    const reaped = await reaper.sweepOnce();

    expect(reaped).toEqual(["T-0001"]);
    expect(clearRunStateFn).toHaveBeenCalledWith({ runsDir: "/runs", taskId: "T-0001" });
  });
});
