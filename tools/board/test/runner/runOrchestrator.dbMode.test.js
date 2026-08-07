import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../../src/runner/plannerFileView.js", () => ({
  materializePlannerFileView: vi.fn(async () => ({ tasksDir: "/repo/worktrees/T-0001/tasks", before: new Map(), hiddenPaths: ["tasks/T-0001.md"] })),
  cleanupPlannerFileView: vi.fn(async () => {}),
  diffPlannerFileView: vi.fn(async () => ({ ok: true, creates: [], updates: [] })),
  applyPlannerFileViewDiff: vi.fn(async () => ({ createdIds: [], updatedIds: [] }))
}));

import { RunOrchestrator } from "../../src/runner/runOrchestrator.js";
import {
  materializePlannerFileView,
  cleanupPlannerFileView,
  diffPlannerFileView,
  applyPlannerFileViewDiff
} from "../../src/runner/plannerFileView.js";

const IMPLEMENTER_DEF = { name: "infra", model: "sonnet", body: "# infra\nImplements board tooling." };
const REVIEWER_DEF = { name: "reviewer", model: "opus", body: "# reviewer\nRead-only VALIDATION gate." };
const PLANNER_DEF = { name: "planner", model: "opus", body: "# planner\nAudits and expands the backlog." };

function fakeChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.pid = 4242;
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
  });
  return child;
}

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

function makeStore(initialTasks) {
  const tasks = new Map(initialTasks.map((t) => [t.id, { ...t }]));
  return {
    tasks,
    async get(id) {
      return tasks.has(id) ? { ...tasks.get(id) } : null;
    },
    async update(id, updates) {
      const existing = tasks.get(id);
      const merged = { ...existing, ...updates, id };
      tasks.set(id, merged);
      return { ...merged };
    }
  };
}

function makeRunLog() {
  const events = [];
  return {
    events,
    async append(event) {
      events.push(event);
    },
    close: vi.fn(async () => {})
  };
}

function makeGithub() {
  return {
    checkAvailability: vi.fn(async () => ({ available: false, reason: "not-installed" })),
    findExistingPr: vi.fn(async () => null),
    createPr: vi.fn(async () => "https://github.com/example/repo/pull/1")
  };
}

function makeGit(overrides = {}) {
  return {
    addWorktree: vi.fn(async () => ({ reused: false })),
    removeWorktree: vi.fn(async () => {}),
    diffNames: vi.fn(async () => ["tools/board/src/thing.js"]),
    commitAll: vi.fn(async () => true),
    push: vi.fn(async () => {}),
    getHeadCommit: vi.fn(async () => "abc1234def5678abc1234def5678abc1234def5"),
    linkBoardNodeModules: vi.fn(async () => {}),
    commitTaskFile: vi.fn(async () => true),
    autoCommitCardsOnCreateFromEnv: vi.fn(() => true),
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
  const kill = vi.fn((run) => run.child.kill());
  return { start, kill, spawnedChildren };
}

async function nthChild(runner, n) {
  await vi.waitFor(() => expect(runner.start).toHaveBeenCalledTimes(n));
  return runner.spawnedChildren[n - 1];
}

function makeOrchestrator({ store, git, runner, hub, github, taskStoreKind, runLogs = [], ...overrides } = {}) {
  const createRunLogFn = vi.fn(async () => {
    const log = makeRunLog();
    runLogs.push(log);
    return log;
  });

  return new RunOrchestrator({
    store,
    hub: hub ?? { broadcast: vi.fn() },
    runner,
    git,
    github: github ?? makeGithub(),
    repoRoot: "/repo",
    worktreesDir: "/repo/worktrees",
    runsDir: "/repo/tasks/.runs",
    agentsDir: "/repo/.claude/agents",
    rulesDir: "/repo/.claude/rules",
    taskStoreKind,
    loadAgentDefFn: (name) => {
      if (name === "reviewer") return REVIEWER_DEF;
      if (name === "planner") return PLANNER_DEF;
      return IMPLEMENTER_DEF;
    },
    loadRulesFn: () => [{ name: "conduct", paths: ["**"], body: "TDD." }],
    resolveAllowedToolsFn: (name) => (name === "reviewer" ? ["Read", "Grep"] : ["Read", "Write", "Bash(git:*)"]),
    createRunLogFn,
    ...overrides
  });
}

describe("RunOrchestrator db mode -- _updateAndBroadcast skips the git commit", () => {
  it("never calls git.commitTaskFile in db mode, but still broadcasts every status flip", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const hub = { broadcast: vi.fn() };
    const orchestrator = makeOrchestrator({ store, git, runner, hub, taskStoreKind: "db" });

    const runPromise = orchestrator.runCard("T-0001");

    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: 'Done. ```verdict\n{"verdict":"PASS","notes":"ok"}\n```' }] } })}\n`)
    );
    reviewChild.emit("exit", 0, null);

    await runPromise;

    expect(git.commitTaskFile).not.toHaveBeenCalled();
    // Real code-worktree git ops (unrelated to card storage) still run as normal.
    expect(git.commitAll).toHaveBeenCalled();
    expect(git.push).toHaveBeenCalled();
    const broadcastTypes = hub.broadcast.mock.calls.map(([msg]) => msg.type);
    expect(broadcastTypes).toContain("changed");
    expect((await store.get("T-0001")).status).toBe("review");
  });

  it("still commits in fs mode (taskStoreKind default) -- unchanged behavior", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 1, null);
    await runPromise;

    expect(git.commitTaskFile).toHaveBeenCalled();
  });
});

describe("RunOrchestrator db mode -- planner ephemeral file view wiring", () => {
  function makeUnassignedTask(overrides = {}) {
    return baseTask({ agent: null, ...overrides });
  }

  it("materializes, reconciles, and cleans up the planner file view around the planner phase in db mode", async () => {
    vi.clearAllMocks();
    const store = makeStore([makeUnassignedTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner, taskStoreKind: "db" });

    const runPromise = orchestrator.runCard("T-0001");

    const plannerChild = await nthChild(runner, 1);
    expect(materializePlannerFileView).toHaveBeenCalledWith(
      expect.objectContaining({ store, worktreeDir: "/repo/worktrees/T-0001" })
    );
    // Materialization happens before the planner ever starts, not after.
    expect(diffPlannerFileView).not.toHaveBeenCalled();

    plannerChild.emit("exit", 0, null);

    await vi.waitFor(() => expect(diffPlannerFileView).toHaveBeenCalled());
    expect(applyPlannerFileViewDiff).toHaveBeenCalled();
    expect(cleanupPlannerFileView).toHaveBeenCalledWith({
      worktreeDir: "/repo/worktrees/T-0001",
      hiddenPaths: ["tasks/T-0001.md"]
    });

    // Let the generic implementer phase fail so the test doesn't need to also drive a reviewer.
    const implChild = await nthChild(runner, 2);
    implChild.emit("exit", 1, null);
    await runPromise;
  });

  it("blocks the card and never reaches the implementer phase when the reconciled diff violates a guardrail", async () => {
    vi.clearAllMocks();
    diffPlannerFileView.mockResolvedValueOnce({
      ok: false,
      violations: [{ file: "tasks/T-0001.md", message: "status changed from \"backlog\" to \"ready\"" }]
    });
    const store = makeStore([makeUnassignedTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner, taskStoreKind: "db" });

    const runPromise = orchestrator.runCard("T-0001");
    const plannerChild = await nthChild(runner, 1);
    plannerChild.emit("exit", 0, null);
    await runPromise;

    expect(applyPlannerFileViewDiff).not.toHaveBeenCalled();
    expect(cleanupPlannerFileView).toHaveBeenCalled();
    expect(runner.start).toHaveBeenCalledTimes(1);
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.body).toMatch(/guardrail violation/i);
  });

  it("cleans up the file view even when the planner phase itself crashes", async () => {
    vi.clearAllMocks();
    const store = makeStore([makeUnassignedTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner, taskStoreKind: "db" });

    const runPromise = orchestrator.runCard("T-0001");
    const plannerChild = await nthChild(runner, 1);
    plannerChild.emit("exit", 1, null);
    await runPromise;

    expect(cleanupPlannerFileView).toHaveBeenCalled();
    expect(diffPlannerFileView).not.toHaveBeenCalled();
    expect((await store.get("T-0001")).status).toBe("blocked");
  });

  it("does not touch the planner file view at all in fs mode (default)", async () => {
    vi.clearAllMocks();
    const store = makeStore([makeUnassignedTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const plannerChild = await nthChild(runner, 1);
    plannerChild.emit("exit", 1, null);
    await runPromise;

    expect(materializePlannerFileView).not.toHaveBeenCalled();
    expect(diffPlannerFileView).not.toHaveBeenCalled();
    expect(applyPlannerFileViewDiff).not.toHaveBeenCalled();
    expect(cleanupPlannerFileView).not.toHaveBeenCalled();
  });
});
