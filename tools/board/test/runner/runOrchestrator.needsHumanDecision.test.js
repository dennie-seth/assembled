import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { RunOrchestrator, MAX_AUTO_RETRY_ATTEMPTS } from "../../src/runner/runOrchestrator.js";

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
    comments: [],
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
    },
    async create(task) {
      tasks.set(task.id, { ...task });
      return { ...task };
    },
    async list() {
      return [...tasks.values()].map((t) => ({ ...t }));
    }
  };
}

function makeIdAllocator(startAt = 2) {
  let n = startAt;
  return { allocate: vi.fn(async () => `T-${String(n++).padStart(4, "0")}`) };
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

const IDENTICAL_STATE = { head: "c".repeat(40), tree: "d".repeat(40), dirty: "" };

/** A distinct tree state per call -- real progress between attempts, so no-progress-abort never fires. */
function movingStates() {
  let n = 0;
  return vi.fn(async () => {
    n += 1;
    return { head: String(n).repeat(40), tree: String(n).repeat(40), dirty: "" };
  });
}

function makeGit(overrides = {}) {
  return {
    readTreeState: vi.fn(async () => ({ ...IDENTICAL_STATE })),
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

function makeOrchestrator({ store, git, runner, hub, github, idAllocator, taskStoreKind = "db", runLogs = [], ...overrides } = {}) {
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
    idAllocator: idAllocator ?? makeIdAllocator(),
    repoRoot: "/repo",
    worktreesDir: "/repo/worktrees",
    runsDir: "/repo/tasks/.runs",
    agentsDir: "/repo/.claude/agents",
    rulesDir: "/repo/.claude/rules",
    taskStoreKind,
    loadAgentDefFn: (name) => (name === "reviewer" ? REVIEWER_DEF : IMPLEMENTER_DEF),
    loadRulesFn: () => [{ name: "conduct", paths: ["**"], body: "TDD." }],
    resolveAllowedToolsFn: (name) => (name === "reviewer" ? ["Read", "Grep"] : ["Read", "Write", "Bash(git:*)"]),
    createRunLogFn,
    crossCheckVerdictFn: ({ verdict }) => verdict,
    appendVerdictEntryFn: async () => {},
    ...overrides
  });
}

/** Drives the nth implementer+reviewer cycle to a FAIL verdict with the given reviewer notes. */
async function driveFailCycle(runner, n, notes) {
  const implChild = await nthChild(runner, n * 2 - 1);
  implChild.emit("exit", 0, null);
  const reviewChild = await nthChild(runner, n * 2);
  reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("FAIL", notes))));
  reviewChild.emit("exit", 0, null);
  return { implChild, reviewChild };
}

/** Drives the nth implementer+reviewer cycle to a NEEDS_HUMAN_DECISION verdict with the given notes. */
async function driveNeedsHumanDecisionCycle(runner, n, notes) {
  const implChild = await nthChild(runner, n * 2 - 1);
  implChild.emit("exit", 0, null);
  const reviewChild = await nthChild(runner, n * 2);
  reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("NEEDS_HUMAN_DECISION", notes))));
  reviewChild.emit("exit", 0, null);
  return { implChild, reviewChild };
}

describe("RunOrchestrator -- NEEDS_HUMAN_DECISION verdict halts the run immediately (T-0341)", () => {
  it("stops after exactly one attempt on the very first NEEDS_HUMAN_DECISION verdict -- never launches a second attempt, the exact 2026-09-08 case", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await driveNeedsHumanDecisionCycle(
      runner,
      1,
      "The card asks for both a synchronous and an async version of the same endpoint -- this is a design decision, not a defect. This must NOT be auto-retried."
    );
    await runPromise;

    // Exactly one implementer+reviewer cycle: 2 runner.start calls, never a 3rd for a retry.
    expect(runner.start).toHaveBeenCalledTimes(2);

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.attempts).toBe(1);
  });

  it("halts immediately even mid-loop, with retry attempts still remaining -- distinct from both exhaustion and no-progress abort", async () => {
    const store = makeStore([baseTask()]);
    // Every attempt's tree state differs, so ordinary FAILs never trip the no-progress abort --
    // isolates that it's the NEEDS_HUMAN_DECISION verdict itself stopping the loop, not §23-a.
    const git = makeGit({ readTreeState: movingStates() });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await driveFailCycle(runner, 1, "distinct failure reason #1: assertion mismatch at line 10");
    await driveFailCycle(runner, 2, "distinct failure reason #2: assertion mismatch at line 20");
    await driveNeedsHumanDecisionCycle(runner, 3, "Reviewer cannot decide which of two conflicting acceptance criteria takes priority.");
    await runPromise;

    // 3 attempts (6 runner.start calls) even though MAX_AUTO_RETRY_ATTEMPTS is 5 and every prior
    // FAIL had a differing signature (i.e. nothing else would have stopped the loop here).
    expect(MAX_AUTO_RETRY_ATTEMPTS).toBeGreaterThan(3);
    expect(runner.start).toHaveBeenCalledTimes(6);

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.attempts).toBe(3);
  });

  it("is textually distinct on the card from an exhausted-attempts FAIL and from a crash/Run Failed note", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await driveNeedsHumanDecisionCycle(runner, 1, "Card asks for a scope decision only a human can make.");
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.body).toMatch(/needs human decision/i);
    expect(finalTask.body).not.toMatch(/auto-retry limit reached/i);
    expect(finalTask.body).not.toMatch(/no progress/i);
    expect(finalTask.body).not.toMatch(/run failed/i);
    // The reviewer's own stated reason is preserved verbatim on the card.
    expect(finalTask.body).toMatch(/Card asks for a scope decision only a human can make\./);
  });

  it("does not create a blocker-report/remediation escalation card -- unlike retry exhaustion, this is not a genuine bug/environmental blocker", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await driveNeedsHumanDecisionCycle(runner, 1, "Needs a human scope call.");
    await runPromise;

    const finalTask = await store.get("T-0001");
    const comment = (finalTask.comments ?? []).find((c) => c.text.includes("Blocker report"));
    expect(comment).toBeUndefined();

    const allTasks = await store.list();
    const remediation = allTasks.find((t) => t.id !== "T-0001");
    expect(remediation).toBeUndefined();
  });
});
