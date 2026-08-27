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

/** A distinct tree state per call -- the branch genuinely moved between attempts. */
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

describe("RunOrchestrator -- no-progress abort on identical failure signature", () => {
  it("escalates after exactly two attempts when two consecutive attempts fail with the same normalized signature", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const idAllocator = makeIdAllocator();
    const orchestrator = makeOrchestrator({ store, git, runner, idAllocator });

    const runPromise = orchestrator.runCard("T-0001");
    // Byte-identical worktree state both attempts, and reviewer notes that differ as much as
    // real ones do -- different ordinal, timestamp and pid. The signature must not care.
    await driveFailCycle(
      runner,
      1,
      "First consecutive FAIL: assertion failed in thing.test.js at 2026-08-24T10:00:00.000Z (pid 111)"
    );
    await driveFailCycle(
      runner,
      2,
      "Second consecutive FAIL: assertion failed in thing.test.js at 2026-08-24T10:05:00.000Z (pid 222)"
    );
    await runPromise;

    // Only 2 attempts (4 runner.start calls), never the 3rd/4th/5th retry.
    expect(runner.start).toHaveBeenCalledTimes(4);

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.attempts).toBe(2);

    const comment = finalTask.comments.find((c) => c.text.includes("Blocker report"));
    expect(comment).toBeTruthy();
    expect(comment.text).toMatch(/no progress/i);
    expect(comment.text).not.toMatch(/auto-retry limit reached/i);
    expect(comment.text).toMatch(/not because attempts were exhausted/i);
    // Names the repeated signature (a hex digest) explicitly.
    expect(comment.text).toMatch(/[0-9a-f]{16,}/);

    const allTasks = await store.list();
    const remediation = allTasks.find((t) => t.id !== "T-0001");
    expect(remediation).toBeTruthy();
    expect(remediation.body).toMatch(/no progress/i);
  });

  it("still runs to the existing cap and escalates the normal way when every attempt's signature differs", async () => {
    const store = makeStore([baseTask()]);
    // The branch moves every attempt: real progress, even though it keeps failing.
    const git = makeGit({ readTreeState: movingStates() });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    for (let n = 1; n <= MAX_AUTO_RETRY_ATTEMPTS; n++) {
      await driveFailCycle(runner, n, `distinct failure reason #${n}: assertion mismatch at line ${n * 10}`);
    }
    await runPromise;

    expect(runner.start).toHaveBeenCalledTimes(MAX_AUTO_RETRY_ATTEMPTS * 2);

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.attempts).toBe(MAX_AUTO_RETRY_ATTEMPTS);
    expect(finalTask.body).toMatch(/auto-retry limit reached/i);

    const comment = finalTask.comments.find((c) => c.text.includes("Blocker report"));
    expect(comment).toBeTruthy();
    expect(comment.text).toMatch(/exhausted/i);
    expect(comment.text).not.toMatch(/no progress/i);
  });

  it("a differing-signature retry still consumes a normal retry slot before a later repeat triggers no-progress abort", async () => {
    const store = makeStore([baseTask()]);
    // Attempt 1 moves the branch; attempts 2 and 3 leave it byte-identical to each other.
    const progressed = [
      { head: "1".repeat(40), tree: "1".repeat(40), dirty: "" },
      { ...IDENTICAL_STATE },
      { ...IDENTICAL_STATE }
    ];
    let k = 0;
    const git = makeGit({
      readTreeState: vi.fn(async () => progressed[k++] ?? progressed[progressed.length - 1])
    });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await driveFailCycle(runner, 1, "first distinct failure: missing config key");
    await driveFailCycle(runner, 2, "second distinct failure: different assertion entirely");
    await driveFailCycle(runner, 3, "second distinct failure: different assertion entirely");
    await runPromise;

    // Attempt 1 landed a commit (state moved), attempts 2 and 3 landed nothing (state repeated).

    // 3 attempts ran (attempt 2 differed from 1, consuming a normal slot; attempt 3 repeated
    // attempt 2's signature and triggered the no-progress abort) -- never reaching attempt 4/5.
    expect(runner.start).toHaveBeenCalledTimes(6);

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.attempts).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // The exact T-0229 incident. Eight consecutive FAILs, worktree byte-identical
  // throughout, reviewer notes opening with an incrementing ordinal. Under the old
  // notes-based signature every attempt hashed differently, so the abort never fired
  // and the card burned all five retry slots on work that could not land.
  // ---------------------------------------------------------------------------
  it("aborts after the 2nd attempt when the branch state is byte-identical but the notes carry an incrementing counter", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit(); // identical state every attempt
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner, idAllocator: makeIdAllocator() });

    const ordinals = ["First", "Second", "Third", "Fourth", "Fifth"];
    const runPromise = orchestrator.runCard("T-0001");
    await driveFailCycle(
      runner,
      1,
      `${ordinals[0]} consecutive FAIL; branch carries exactly two commits (ee5d6e0, 87188e1), tree clean, zero new artifacts.`
    );
    await driveFailCycle(
      runner,
      2,
      `${ordinals[1]} consecutive FAIL; I re-verified independently and it is byte-identical to run 1 -- branch carries exactly two commits (ee5d6e0, 87188e1), tree clean, zero new artifacts.`
    );
    await runPromise;

    // Two attempts, not five: 4 runner.start calls (impl+reviewer x2).
    expect(runner.start).toHaveBeenCalledTimes(4);

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.attempts).toBe(2);

    const comment = finalTask.comments.find((c) => c.text.includes("Blocker report"));
    expect(comment.text).toMatch(/no progress/i);
    expect(comment.text).not.toMatch(/auto-retry limit reached/i);
  });

  it("does not abort when only an uncommitted file appeared between attempts -- that is still progress", async () => {
    const store = makeStore([baseTask()]);
    const states = [
      { ...IDENTICAL_STATE, dirty: "" },
      { ...IDENTICAL_STATE, dirty: "?? assets/out/arm_b/attempt_1/main.png" },
      { ...IDENTICAL_STATE, dirty: "?? assets/out/arm_b/attempt_2/main.png" },
      { ...IDENTICAL_STATE, dirty: "?? assets/out/arm_b/attempt_3/main.png" },
      { ...IDENTICAL_STATE, dirty: "?? assets/out/arm_b/attempt_4/main.png" }
    ];
    let i = 0;
    const git = makeGit({ readTreeState: vi.fn(async () => states[i++] ?? states[states.length - 1]) });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    for (let n = 1; n <= MAX_AUTO_RETRY_ATTEMPTS; n++) {
      await driveFailCycle(runner, n, "same reviewer text every time, but the tree keeps changing");
    }
    await runPromise;

    expect(runner.start).toHaveBeenCalledTimes(MAX_AUTO_RETRY_ATTEMPTS * 2);
    expect((await store.get("T-0001")).attempts).toBe(MAX_AUTO_RETRY_ATTEMPTS);
  });

  it("falls back to the full retry cap when the worktree state cannot be read", async () => {
    const store = makeStore([baseTask()]);
    // No readTreeState at all -- signature is null, so nothing is ever compared.
    const git = makeGit({ readTreeState: undefined });
    delete git.readTreeState;
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    for (let n = 1; n <= MAX_AUTO_RETRY_ATTEMPTS; n++) {
      await driveFailCycle(runner, n, "identical text every attempt");
    }
    await runPromise;

    expect(runner.start).toHaveBeenCalledTimes(MAX_AUTO_RETRY_ATTEMPTS * 2);
  });

  it("does not abort the run when reading the worktree state throws", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit({
      readTreeState: vi.fn(async () => {
        throw new Error("git rev-parse HEAD failed: fatal: bad revision");
      })
    });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    for (let n = 1; n <= MAX_AUTO_RETRY_ATTEMPTS; n++) {
      await driveFailCycle(runner, n, "identical text every attempt");
    }
    await runPromise;

    expect(runner.start).toHaveBeenCalledTimes(MAX_AUTO_RETRY_ATTEMPTS * 2);
    expect((await store.get("T-0001")).status).toBe("blocked");
  });
});
