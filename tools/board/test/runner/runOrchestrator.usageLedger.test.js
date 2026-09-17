import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunOrchestrator } from "../../src/runner/runOrchestrator.js";
import {
  recordAttemptUsage,
  ensureExecutionId,
  clearExecutionId,
  drainPendingUsageWrites,
  listCardUsageEntries,
  executionTotal
} from "../../src/runner/usageLedger.js";

const IMPLEMENTER_DEF = { name: "infra", model: "sonnet", body: "# infra\nImplements board tooling." };
const REVIEWER_DEF = { name: "reviewer", model: "opus", body: "# reviewer\nRead-only VALIDATION gate." };
const PLANNER_DEF = { name: "planner", model: "opus", body: "# planner\nExpands unassigned cards." };

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

/** Real 429 session-limit stop shape (card evidence, T-0367/T-0366's own run logs). */
function quotaStopResultEvent() {
  return {
    type: "result",
    is_error: true,
    terminal_reason: "api_error",
    api_error_status: 429,
    result: "You've hit your session limit · resets 6pm (Europe/Budapest)",
    total_cost_usd: 1.42,
    usage: { input_tokens: 12000, output_tokens: 3400, cache_creation_input_tokens: 500, cache_read_input_tokens: 8000 }
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

function makeGithub(overrides = {}) {
  return {
    checkAvailability: vi.fn(async () => ({ available: false, reason: "not-installed" })),
    findExistingPr: vi.fn(async () => null),
    createPr: vi.fn(async () => "https://github.com/example/repo/pull/1"),
    ...overrides
  };
}

function makeGit(overrides = {}) {
  return {
    readTreeState: vi.fn(async () => ({ head: "a".repeat(40), tree: "b".repeat(40), dirty: "" })),
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

function makeOrchestrator({
  store,
  git,
  runner,
  hub,
  github,
  runLogs = [],
  recordAttemptUsageFn,
  ensureExecutionIdFn,
  clearExecutionIdFn,
  drainPendingUsageWritesFn,
  ...overrides
} = {}) {
  const createRunLogFn = vi.fn(async () => {
    const log = makeRunLog();
    runLogs.push(log);
    return log;
  });

  let executionIdCounter = 0;

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
    loadAgentDefFn: (name) => (name === "reviewer" ? REVIEWER_DEF : name === "planner" ? PLANNER_DEF : IMPLEMENTER_DEF),
    loadRulesFn: () => [{ name: "conduct", paths: ["**"], body: "TDD." }],
    resolveAllowedToolsFn: (name) => (name === "reviewer" ? ["Read", "Grep"] : ["Read", "Write", "Bash(git:*)"]),
    createRunLogFn,
    crossCheckVerdictFn: ({ verdict }) => verdict,
    readVerdictEntriesFn: async () => [],
    appendVerdictEntryFn: async () => {},
    recordAttemptUsageFn: recordAttemptUsageFn ?? vi.fn(async () => {}),
    ensureExecutionIdFn: ensureExecutionIdFn ?? vi.fn(async () => `exec-${++executionIdCounter}`),
    clearExecutionIdFn: clearExecutionIdFn ?? vi.fn(async () => {}),
    drainPendingUsageWritesFn: drainPendingUsageWritesFn ?? vi.fn(async () => {}),
    ...overrides
  });
}

/** Every call the orchestrator made to recordAttemptUsageFn, as plain option objects. */
function usageCalls(recordAttemptUsageFn) {
  return recordAttemptUsageFn.mock.calls.map(([opts]) => opts);
}

/** The LAST recorded call for a given (attempt, phase) pair -- the terminal classification. */
function lastUsageCallFor(recordAttemptUsageFn, attempt, phase) {
  const calls = usageCalls(recordAttemptUsageFn).filter((c) => c.attempt === attempt && c.phase === phase);
  return calls[calls.length - 1];
}

describe("RunOrchestrator — usage ledger wiring (T-0367 T-A)", () => {
  it("on PASS, records a 'success' usage entry (complete: true) for both the implementer and reviewer phases", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const recordAttemptUsageFn = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({ store, git, runner, recordAttemptUsageFn });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.stdout.emit("data", ndjson(assistantEvent("implementing...")));
    implChild.emit("exit", 0, null);

    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`Reviewed. ${verdictBlock("PASS", "all green")}`)));
    reviewChild.emit("exit", 0, null);

    await runPromise;

    const impl = lastUsageCallFor(recordAttemptUsageFn, 1, "implementer");
    expect(impl).toMatchObject({ cardId: "T-0001", attempt: 1, retry: 0, outcome: "success", complete: true });

    const review = lastUsageCallFor(recordAttemptUsageFn, 1, "reviewer");
    expect(review).toMatchObject({ cardId: "T-0001", attempt: 1, retry: 0, outcome: "success", complete: true });
  });

  it("on reviewer FAIL (retryable), records 'reviewer_fail' for that attempt's reviewer phase and 'success' for its implementer phase, then fresh entries at the next attempt", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const recordAttemptUsageFn = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({ store, git, runner, recordAttemptUsageFn });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild1 = await nthChild(runner, 1);
    implChild1.emit("exit", 0, null);
    const reviewChild1 = await nthChild(runner, 2);
    reviewChild1.stdout.emit("data", ndjson(assistantEvent(verdictBlock("FAIL", "missing test"))));
    reviewChild1.emit("exit", 0, null);

    const implChild2 = await nthChild(runner, 3);
    implChild2.emit("exit", 0, null);
    const reviewChild2 = await nthChild(runner, 4);
    reviewChild2.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fixed"))));
    reviewChild2.emit("exit", 0, null);

    await runPromise;

    expect(lastUsageCallFor(recordAttemptUsageFn, 1, "implementer")).toMatchObject({ outcome: "success", complete: true });
    expect(lastUsageCallFor(recordAttemptUsageFn, 1, "reviewer")).toMatchObject({ outcome: "reviewer_fail", complete: true });
    expect(lastUsageCallFor(recordAttemptUsageFn, 2, "implementer")).toMatchObject({ outcome: "success", complete: true });
    expect(lastUsageCallFor(recordAttemptUsageFn, 2, "reviewer")).toMatchObject({ outcome: "success", complete: true });
  });

  it("records a 'crashed' usage entry (complete: false) when the implementer phase exits non-zero", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const recordAttemptUsageFn = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({ store, git, runner, recordAttemptUsageFn });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 1, null);
    await runPromise;

    expect(lastUsageCallFor(recordAttemptUsageFn, 1, "implementer")).toMatchObject({ outcome: "crashed", complete: false });
  });

  it("records a 'cancelled' usage entry (complete: false) for the phase in flight when the run is cancelled", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const recordAttemptUsageFn = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({ store, git, runner, recordAttemptUsageFn });

    const runPromise = orchestrator.runCard("T-0001");
    await nthChild(runner, 1);
    await orchestrator.cancelRun("T-0001");
    await runPromise;

    expect(lastUsageCallFor(recordAttemptUsageFn, 1, "implementer")).toMatchObject({ outcome: "cancelled", complete: false });
  });

  it("records a 'phase_timeout' usage entry (complete: false) for an inactivity-timed-out implementer phase, treated as a retryable FAIL", async () => {
    vi.useFakeTimers();
    try {
      const store = makeStore([baseTask()]);
      const git = makeGit();
      const runner = makeRunner();
      const recordAttemptUsageFn = vi.fn(async () => {});
      const orchestrator = makeOrchestrator({
        store,
        git,
        runner,
        recordAttemptUsageFn,
        phaseTimeoutMs: 60 * 60 * 1000,
        inactivityTimeoutMs: 1000,
        probeLivenessMtimeFn: vi.fn(async () => null),
        writeRunStateFn: vi.fn(async () => {}),
        clearRunStateFn: vi.fn(async () => {})
      });

      const runPromise = orchestrator.runCard("T-0001");
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.start).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);

      expect(lastUsageCallFor(recordAttemptUsageFn, 1, "implementer")).toMatchObject({ outcome: "phase_timeout", complete: false });

      // The inactivity timeout is a synthetic, retryable FAIL -- drive the retry to PASS so the
      // run settles instead of hanging on further fake-timer real time.
      const implChild2 = await nthChild(runner, 2);
      implChild2.emit("exit", 0, null);
      const reviewChild2 = await nthChild(runner, 3);
      reviewChild2.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fixed"))));
      reviewChild2.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(0);

      await runPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a clean-exit phase carrying a 429 session-limit result event as 'quota_stop' (complete: true), not 'success'", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const recordAttemptUsageFn = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({ store, git, runner, recordAttemptUsageFn });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.stdout.emit("data", ndjson(quotaStopResultEvent()));
    implChild.emit("exit", 0, null);

    await vi.waitFor(() => {
      expect(lastUsageCallFor(recordAttemptUsageFn, 1, "implementer")).toMatchObject({ outcome: "quota_stop", complete: true });
    });

    // Drive the reviewer to completion too, so the run settles and the test doesn't hang.
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fine"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;
  });

  it("records a 'success' usage entry for the planner phase on an unassigned card, keyed at attempt 0", async () => {
    const store = makeStore([baseTask({ agent: null, id: "T-0002" })]);
    const git = makeGit();
    const runner = makeRunner();
    const recordAttemptUsageFn = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({ store, git, runner, recordAttemptUsageFn });

    const runPromise = orchestrator.runCard("T-0002");
    const plannerChild = await nthChild(runner, 1);
    plannerChild.emit("exit", 0, null);

    const implChild = await nthChild(runner, 2);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 3);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "planned and built"))));
    reviewChild.emit("exit", 0, null);

    await runPromise;

    expect(lastUsageCallFor(recordAttemptUsageFn, 0, "planning")).toMatchObject({ outcome: "success", complete: true });
  });

  it("records a 'success' usage entry for the merge-conflict phase once conflicts are resolved and pushed", async () => {
    const store = makeStore([baseTask()]);
    const conflictResult = {
      conflicted: true,
      conflictedFiles: ["tools/board/src/thing.js"],
      hunks: { "tools/board/src/thing.js": "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/develop\n" }
    };
    const git = makeGit({
      fetch: vi.fn(async () => {}),
      mergeDevelop: vi.fn(async () => conflictResult),
      mergeStatus: vi.fn(async () => []),
      hasUncommittedChanges: vi.fn(async () => false)
    });
    const runner = makeRunner();
    const github = makeGithub({
      checkAvailability: vi.fn(async () => ({ available: true, reason: null })),
      createPr: vi.fn(async () => "https://github.com/example/repo/pull/9")
    });
    const recordAttemptUsageFn = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({ store, git, runner, github, recordAttemptUsageFn });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "suite green"))));
    reviewChild.emit("exit", 0, null);
    const conflictChild = await nthChild(runner, 3);
    conflictChild.stdout.emit("data", ndjson(assistantEvent("resolved the conflict")));
    conflictChild.emit("exit", 0, null);
    await runPromise;

    expect(lastUsageCallFor(recordAttemptUsageFn, 0, "merge-conflict")).toMatchObject({ outcome: "success", complete: true });
  });

  it("records usage incrementally mid-phase, not only at termination", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const recordAttemptUsageFn = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({ store, git, runner, recordAttemptUsageFn });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.stdout.emit("data", ndjson(assistantEvent("still working...")));
    await vi.waitFor(() => {
      expect(usageCalls(recordAttemptUsageFn).some((c) => c.attempt === 1 && c.phase === "implementer" && c.complete === false)).toBe(true);
    });

    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fine"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;
  });
});

describe("RunOrchestrator — execution identity (Codex review 2026-09-12, P1)", () => {
  it("mints the execution id before the first process is spawned, and every recordAttemptUsageFn call for the run carries it", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const recordAttemptUsageFn = vi.fn(async () => {});
    const callOrder = [];
    const ensureExecutionIdFn = vi.fn(async () => {
      callOrder.push("ensureExecutionId");
      return "exec-fixed";
    });
    runner.start.mockImplementation(async () => {
      callOrder.push("runner.start");
      const child = fakeChildProcess();
      runner.spawnedChildren.push(child);
      return { runId: "run", child };
    });
    const orchestrator = makeOrchestrator({ store, git, runner, recordAttemptUsageFn, ensureExecutionIdFn });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fine"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(callOrder[0]).toBe("ensureExecutionId");
    expect(ensureExecutionIdFn).toHaveBeenCalledTimes(1);
    const calls = usageCalls(recordAttemptUsageFn);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.executionId).toBe("exec-fixed");
    }
  });

  it("clears the persisted execution id on completion so the next launch mints a fresh one", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const clearExecutionIdFn = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({ store, git, runner, clearExecutionIdFn });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fine"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(clearExecutionIdFn).toHaveBeenCalledWith(expect.objectContaining({ cardId: "T-0001" }));
  });

  it("gives two separate runCard() launches of the same card distinct execution ids", async () => {
    const store = makeStore([baseTask()]);
    const recordAttemptUsageFn = vi.fn(async () => {});
    let executionIdCounter = 0;
    const ensureExecutionIdFn = vi.fn(async () => `exec-${++executionIdCounter}`);

    async function driveOnePassingRun() {
      const git = makeGit();
      const runner = makeRunner();
      const orchestrator = makeOrchestrator({ store, git, runner, recordAttemptUsageFn, ensureExecutionIdFn });
      const runPromise = orchestrator.runCard("T-0001");
      const implChild = await nthChild(runner, 1);
      implChild.emit("exit", 0, null);
      const reviewChild = await nthChild(runner, 2);
      reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fine"))));
      reviewChild.emit("exit", 0, null);
      await runPromise;
    }

    await driveOnePassingRun();
    await store.update("T-0001", { status: "ready" });
    await driveOnePassingRun();

    const executionIds = new Set(usageCalls(recordAttemptUsageFn).map((c) => c.executionId));
    expect(executionIds.size).toBe(2);
  });
});

describe("RunOrchestrator — usage-ledger write draining and instrumentation isolation (Codex review 2026-09-12, P2)", () => {
  it("drains pending usage writes before runCard() resolves", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const callOrder = [];
    const recordAttemptUsageFn = vi.fn(async () => {
      callOrder.push("recordAttemptUsage");
    });
    const drainPendingUsageWritesFn = vi.fn(async () => {
      callOrder.push("drain");
    });
    const orchestrator = makeOrchestrator({ store, git, runner, recordAttemptUsageFn, drainPendingUsageWritesFn });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fine"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(drainPendingUsageWritesFn).toHaveBeenCalled();
    expect(callOrder[callOrder.length - 1]).toBe("drain");
  });

  it("an instrumentation failure (recordAttemptUsageFn rejects on every call) never changes the run's verdict", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const recordAttemptUsageFn = vi.fn(async () => {
      throw new Error("disk full");
    });
    const orchestrator = makeOrchestrator({ store, git, runner, recordAttemptUsageFn });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`Reviewed. ${verdictBlock("PASS", "all green")}`)));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(recordAttemptUsageFn).toHaveBeenCalled();
    const task = await store.get("T-0001");
    expect(task.status).toBe("review");
  });
});

describe("RunOrchestrator — quota event receive-timestamp stamping (Codex review 2026-09-12, P1)", () => {
  it("stamps a rate_limit_event with receivedAtMs at arrival, before it's appended to the run log", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const runLogs = [];
    const fixedNow = new Date("2026-09-12T12:00:00.000Z");
    const orchestrator = makeOrchestrator({ store, git, runner, runLogs, now: () => fixedNow });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.stdout.emit(
      "data",
      ndjson({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt: 9999999999 } })
    );
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fine"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    const implementerLog = runLogs[0];
    const quotaEvent = implementerLog.events.find((e) => e.type === "rate_limit_event");
    expect(quotaEvent).toBeDefined();
    expect(quotaEvent.receivedAtMs).toBe(fixedNow.getTime());
  });

  it("does not overwrite an already-stamped receivedAtMs (e.g. on a replay)", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const runLogs = [];
    const orchestrator = makeOrchestrator({ store, git, runner, runLogs });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.stdout.emit(
      "data",
      ndjson({ type: "rate_limit_event", receivedAtMs: 12345, rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt: 9999999999 } })
    );
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fine"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    const implementerLog = runLogs[0];
    const quotaEvent = implementerLog.events.find((e) => e.type === "rate_limit_event");
    expect(quotaEvent.receivedAtMs).toBe(12345);
  });
});

describe("RunOrchestrator — crash-recovery invocation identity (Codex review 2, 2026-09-12, finding 2)", () => {
  it("a phase restarted after a board crash never overwrites the interrupted phase's own ledger entry, and the execution total is 125", async () => {
    // Real ledger persistence throughout -- a mocked recordAttemptUsageFn (as every other test in
    // this file uses) can't reproduce this bug: Codex's reproduction needed the real
    // recordAttemptUsage + ensureExecutionId functions actually writing/reading disk state.
    const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-orch-crash-recovery-"));
    let invocationCounter = 0;
    const generateInvocationIdFn = () => `inv-${++invocationCounter}`;

    try {
      const store = makeStore([baseTask()]);
      const git = makeGit();

      // First launch: the implementer phase reports 100 tokens, then the board "dies" -- its
      // process never exits, so runCard() never reaches its own finally/cleanup (no
      // clearExecutionId, no drain). This is what leaves the persisted execution id sidecar
      // behind for the restarted launch to recover.
      const runner1 = makeRunner();
      const orchestrator1 = makeOrchestrator({
        store,
        git,
        runner: runner1,
        runsDir,
        recordAttemptUsageFn: recordAttemptUsage,
        ensureExecutionIdFn: ensureExecutionId,
        clearExecutionIdFn: clearExecutionId,
        drainPendingUsageWritesFn: drainPendingUsageWrites,
        generateInvocationIdFn
      });

      const firstRun = orchestrator1.runCard("T-0001");
      firstRun.catch(() => {}); // deliberately never awaited to completion -- see below
      const implChild1 = await nthChild(runner1, 1);
      implChild1.stdout.emit(
        "data",
        ndjson({ type: "assistant", session_id: "sess-1", message: { id: "msg-1", model: "fixture", usage: { input_tokens: 100, output_tokens: 1 } } })
      );
      // No 'exit' event ever fires for this child -- the process (and the whole board) is gone.
      await vi.waitFor(async () => {
        const entries = await listCardUsageEntries({ runsDir, cardId: "T-0001" });
        expect(entries.length).toBeGreaterThan(0);
      });

      const interruptedEntries = await listCardUsageEntries({ runsDir, cardId: "T-0001" });
      expect(interruptedEntries).toHaveLength(1);
      expect(interruptedEntries[0]).toMatchObject({ outcome: "in_progress", complete: false });
      expect(interruptedEntries[0].tokens.input).toBe(100);
      const executionId = interruptedEntries[0].executionId;
      const interruptedInvocationId = interruptedEntries[0].invocationId;

      // Board restarts: a fresh orchestrator instance (fresh in-memory state), same runsDir --
      // ensureExecutionId reads the persisted sidecar and reuses the same execution id, exactly
      // as a genuine recovery should. The restarted implementer phase is a brand-new process and
      // must mint its own invocation id rather than colliding with the interrupted one's.
      // (A real restart's orphan-reaper/liveness path is what actually resets a crashed card's
      // status back to "ready" before re-launching it -- out of scope here, so it's done directly.)
      await store.update("T-0001", { status: "ready" });
      const runner2 = makeRunner();
      const orchestrator2 = makeOrchestrator({
        store,
        git,
        runner: runner2,
        runsDir,
        recordAttemptUsageFn: recordAttemptUsage,
        ensureExecutionIdFn: ensureExecutionId,
        clearExecutionIdFn: clearExecutionId,
        drainPendingUsageWritesFn: drainPendingUsageWrites,
        generateInvocationIdFn
      });

      const secondRun = orchestrator2.runCard("T-0001");
      const implChild2 = await nthChild(runner2, 1);
      implChild2.stdout.emit(
        "data",
        ndjson({ type: "assistant", session_id: "sess-2", message: { id: "msg-2", model: "fixture", usage: { input_tokens: 25, output_tokens: 1 } } })
      );
      implChild2.emit("exit", 0, null);
      const reviewChild2 = await nthChild(runner2, 2);
      reviewChild2.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fine"))));
      reviewChild2.emit("exit", 0, null);
      await secondRun;

      const entries = await listCardUsageEntries({ runsDir, cardId: "T-0001" });
      // The interrupted phase's own entry must still be there, untouched, alongside the
      // restarted phase's entries -- not overwritten.
      const stillInterrupted = entries.find((e) => e.invocationId === interruptedInvocationId);
      expect(stillInterrupted).toBeTruthy();
      expect(stillInterrupted.tokens.input).toBe(100);
      expect(stillInterrupted.complete).toBe(false);

      // Recovery reused the same execution id -- this is a restart of the SAME logical launch.
      expect(entries.every((e) => e.executionId === executionId)).toBe(true);
      // But every phase spawn got its own invocation id -- the restarted implementer's entry
      // never shares a key with the interrupted one's.
      const invocationIds = new Set(entries.map((e) => e.invocationId));
      expect(invocationIds.size).toBeGreaterThanOrEqual(2);

      expect(executionTotal(entries, executionId).tokens.input).toBe(125);
    } finally {
      await fs.rm(runsDir, { recursive: true, force: true });
    }
  });
});
