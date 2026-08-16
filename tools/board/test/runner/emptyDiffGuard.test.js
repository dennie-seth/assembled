/**
 * Tests for the pre-validation empty-diff guard in RunOrchestrator._runAttempt.
 *
 * When `git diff develop...HEAD` returns no changed files (the implementer phase
 * produced no committed changes), the orchestrator must block the card and skip
 * the reviewer entirely — launching the reviewer on an empty diff always produces
 * a FAIL verdict citing "implementation not committed", wasting a retry attempt.
 *
 * Root cause addressed: T-0110, T-0129, T-0131, T-0132 all failed review with
 * "no commits" or "unstaged working-tree modifications" — 7 occurrences across
 * 5 cards, Category A of the T-0138 flow-health analysis.
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { RunOrchestrator } from "../../src/runner/runOrchestrator.js";

const IMPLEMENTER_DEF = { name: "infra", model: "sonnet", body: "# infra\nImplements board tooling." };
const REVIEWER_DEF = { name: "reviewer", model: "opus", body: "# reviewer\nRead-only VALIDATION gate." };

function fakeChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.pid = 4242;
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
  });
  return child;
}

function ndjson(event) {
  return Buffer.from(`${JSON.stringify(event)}\n`);
}

function assistantEvent(text) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

function verdictBlock(verdict, notes) {
  return `\`\`\`verdict\n${JSON.stringify({ verdict, notes })}\n\`\`\``;
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
    commitAll: vi.fn(async () => false),
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

function makeOrchestrator({ store, git, runner, hub, runLogs = [], ...overrides } = {}) {
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
    repoRoot: "/repo",
    worktreesDir: "/repo/worktrees",
    runsDir: "/repo/tasks/.runs",
    agentsDir: "/repo/.claude/agents",
    rulesDir: "/repo/.claude/rules",
    loadAgentDefFn: (name) => (name === "reviewer" ? REVIEWER_DEF : IMPLEMENTER_DEF),
    loadRulesFn: () => [{ name: "conduct", paths: ["**"], body: "TDD." }],
    resolveAllowedToolsFn: (name) => (name === "reviewer" ? ["Read", "Grep"] : ["Read", "Write", "Bash(git:*)"]),
    createRunLogFn,
    writeRunStateFn: vi.fn(async () => {}),
    clearRunStateFn: vi.fn(async () => {}),
    // Not exercising the harness-side verdict cross-check here (see verdictCrossCheck.test.js
    // and runOrchestrator.test.js's dedicated describe block) -- default to a passthrough.
    crossCheckVerdictFn: ({ verdict }) => verdict,
    ...overrides
  });
}

describe("RunOrchestrator — empty-diff guard: no commits on branch", () => {
  it("blocks the card and skips the reviewer when diffNames returns an empty array", async () => {
    // Simulate: implementer ran, produced no commits, capture safety net also found nothing
    const store = makeStore([baseTask()]);
    const git = makeGit({
      diffNames: vi.fn(async () => []),
      commitAll: vi.fn(async () => false) // capture safety net finds nothing to commit
    });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");

    // Implementer phase exits cleanly with code 0
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);

    await runPromise;

    // Reviewer must never have been spawned — only 1 child process (the implementer)
    expect(runner.start).toHaveBeenCalledTimes(1);

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.body).toMatch(/no commits on branch/i);
  });

  it("appends a note to the card body explaining why validation was skipped", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit({ diffNames: vi.fn(async () => []) });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");

    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);

    await runPromise;

    const finalTask = await store.get("T-0001");
    // Note must clearly identify why validation was skipped
    expect(finalTask.body).toContain("no commits on branch");
    // Card must be blocked (not in-progress or validation)
    expect(finalTask.status).toBe("blocked");
  });
});

describe("RunOrchestrator — empty-diff guard: commits present, proceed to reviewer", () => {
  it("runs the reviewer normally when diffNames returns a non-empty array", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit({
      diffNames: vi.fn(async () => ["tools/board/src/runner/runOrchestrator.js"])
    });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");

    // Implementer phase
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);

    // Reviewer phase must be spawned because diff is non-empty
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit(
      "data",
      ndjson(assistantEvent(`Looks good. ${verdictBlock("PASS", "all checks green")}`))
    );
    reviewChild.emit("exit", 0, null);

    await runPromise;

    // Both implementer and reviewer were run
    expect(runner.start).toHaveBeenCalledTimes(2);

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
  });

  it("does not append a 'no commits' note when the diff is non-empty", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit({
      diffNames: vi.fn(async () => ["tools/board/src/runner/runOrchestrator.js"])
    });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");

    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);

    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit(
      "data",
      ndjson(assistantEvent(`All good. ${verdictBlock("PASS", "suite green")}`))
    );
    reviewChild.emit("exit", 0, null);

    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.body).not.toContain("no commits on branch");
  });
});
