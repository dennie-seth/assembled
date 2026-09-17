import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { RunOrchestrator, MAX_AUTO_RETRY_ATTEMPTS } from "../../src/runner/runOrchestrator.js";
import { ROUND_CAP } from "../../src/lib/roundCap.js";

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
    round: 0,
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

/** Drives every attempt of a run to FAIL with distinct signatures, exhausting maxAttempts. */
async function driveExhaustedFailRun(runner, maxAttempts, notesPrefix) {
  for (let i = 1; i <= maxAttempts; i += 1) {
    await driveFailCycle(runner, i, `${notesPrefix} #${i}: distinct failure signature`);
  }
}

describe("RunOrchestrator -- experiment-round cap (T-0344)", () => {
  it("increments the round counter exactly once when a run settles blocked on exhausted retries", async () => {
    const store = makeStore([baseTask({ round: 0 })]);
    const git = makeGit({ readTreeState: movingStates() });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await driveExhaustedFailRun(runner, MAX_AUTO_RETRY_ATTEMPTS, "distinct failure reason");
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.round).toBe(1);
  });

  it("increments the round counter exactly once when a run settles blocked on NEEDS_HUMAN_DECISION", async () => {
    const store = makeStore([baseTask({ round: 0 })]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await driveNeedsHumanDecisionCycle(runner, 1, "Card asks for a scope decision only a human can make.");
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.round).toBe(1);
  });

  it("does NOT increment the round counter for a retrying FAIL -- only a settled, stopping outcome counts", async () => {
    const store = makeStore([baseTask({ round: 0 })]);
    // Distinct tree states so ordinary FAILs never trip no-progress-abort early.
    const git = makeGit({ readTreeState: movingStates() });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await driveFailCycle(runner, 1, "distinct failure reason #1");
    // Card is still mid-run (retrying, not the final attempt) -- round must still read 0 here.
    expect((await store.get("T-0001")).round).toBe(0);

    // Finish out the remaining attempts to let the run settle and complete cleanly.
    for (let i = 2; i <= MAX_AUTO_RETRY_ATTEMPTS; i += 1) {
      await driveFailCycle(runner, i, `distinct failure reason #${i}`);
    }
    await runPromise;

    expect((await store.get("T-0001")).round).toBe(1);
  });

  it("accumulates across separate runCard invocations (rounds), independent of the attempts counter", async () => {
    const store = makeStore([baseTask({ round: 0 })]);
    const git1 = makeGit({ readTreeState: movingStates() });
    const runner1 = makeRunner();
    const orchestrator1 = makeOrchestrator({ store, git: git1, runner: runner1 });

    // Round 1: settles blocked on NEEDS_HUMAN_DECISION.
    const run1 = orchestrator1.runCard("T-0001");
    await driveNeedsHumanDecisionCycle(runner1, 1, "First round's open question.");
    await run1;
    expect((await store.get("T-0001")).round).toBe(1);

    // Round 2: a fresh runCard invocation (the card was relaunched after settling), again ending
    // in exhausted FAILs -- a completely separate run, its own fresh attempts count from 1.
    const git2 = makeGit({ readTreeState: movingStates() });
    const runner2 = makeRunner();
    const orchestrator2 = makeOrchestrator({ store, git: git2, runner: runner2 });
    const run2 = orchestrator2.runCard("T-0001");
    await driveExhaustedFailRun(runner2, MAX_AUTO_RETRY_ATTEMPTS, "second round failure reason");
    await run2;

    const finalTask = await store.get("T-0001");
    expect(finalTask.round).toBe(ROUND_CAP);
    expect(finalTask.attempts).toBe(MAX_AUTO_RETRY_ATTEMPTS);
  });

  it("posts a discoverable comment naming the required human action once the cap is reached", async () => {
    const store = makeStore([baseTask({ round: ROUND_CAP - 1 })]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await driveNeedsHumanDecisionCycle(runner, 1, "Second round's open question too.");
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.round).toBe(ROUND_CAP);
    const comment = (finalTask.comments ?? []).find((c) => c.text.includes("ROUND CAP REACHED"));
    expect(comment).toBeDefined();
    expect(comment.text).toMatch(/RESCOPED/);
  });

  it("does NOT post the round-cap comment while still below the cap", async () => {
    const store = makeStore([baseTask({ round: 0 })]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await driveNeedsHumanDecisionCycle(runner, 1, "First round's open question.");
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.round).toBe(1);
    const comment = (finalTask.comments ?? []).find((c) => c.text?.includes("ROUND CAP REACHED"));
    expect(comment).toBeUndefined();
  });

  it("resets the round counter to 0 on a PASS -- a promoted deliverable clears the cap", async () => {
    const store = makeStore([baseTask({ round: ROUND_CAP })]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "Looks good."))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
    expect(finalTask.round).toBe(0);
  });
});
