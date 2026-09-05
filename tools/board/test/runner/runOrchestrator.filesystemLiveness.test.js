import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { RunOrchestrator, MAX_AUTO_RETRY_ATTEMPTS } from "../../src/runner/runOrchestrator.js";
import { probeLivenessMtime, DEFAULT_LIVENESS_PROBE_INTERVAL_MS } from "../../src/runner/filesystemLiveness.js";

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
    fetch: vi.fn(async () => {}),
    mergeDevelop: vi.fn(async () => ({ conflicted: false, changed: false })),
    mergeStatus: vi.fn(async () => []),
    hasUncommittedChanges: vi.fn(async () => false),
    abortMerge: vi.fn(async () => {}),
    ...overrides
  };
}

function makeGithub() {
  return {
    checkAvailability: vi.fn(async () => ({ available: false, reason: "not-installed" })),
    findExistingPr: vi.fn(async () => null),
    createPr: vi.fn(async () => "https://github.com/example/repo/pull/1")
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

function makeOrchestrator({ store, git, runner, hub, github, runLogs = [], ...overrides } = {}) {
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
    loadAgentDefFn: (name) => (name === "reviewer" ? REVIEWER_DEF : IMPLEMENTER_DEF),
    loadRulesFn: () => [{ name: "conduct", paths: ["**"], body: "TDD." }],
    resolveAllowedToolsFn: (name) => (name === "reviewer" ? ["Read", "Grep"] : ["Read", "Write", "Bash(git:*)"]),
    createRunLogFn,
    crossCheckVerdictFn: ({ verdict }) => verdict,
    ...overrides
  });
}

/** Deterministic stand-in for probeLivenessMtimeFn: increments its reported mtime on every call until stopGrowing() is invoked, after which it plateaus (same shape as a training job that stops writing checkpoints). */
function makeGrowingProbe(path = "/repo/worktrees/T-0001") {
  let mtimeMs = 0;
  let growing = true;
  const fn = vi.fn(async () => {
    if (growing) mtimeMs += 1;
    return { path, mtimeMs };
  });
  fn.stopGrowing = () => {
    growing = false;
  };
  return fn;
}

async function driveToPass(runner, startIndex) {
  const implChild = runner.spawnedChildren[startIndex];
  implChild.emit("exit", 0, null);
  await vi.advanceTimersByTimeAsync(0);
  const reviewChild = runner.spawnedChildren[startIndex + 1];
  reviewChild.stdout.emit("data", ndjson(assistantEvent(`ok ${verdictBlock("PASS", "green")}`)));
  reviewChild.emit("exit", 0, null);
  await vi.advanceTimersByTimeAsync(0);
}

describe("RunOrchestrator — filesystem-progress liveness (T-0308: subagent-owned work invisible on stdout)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wires the bounded fixed-interval prober and the real fs-backed probe by default", () => {
    const orchestrator = makeOrchestrator({ store: makeStore([baseTask()]), git: makeGit(), runner: makeRunner() });
    expect(orchestrator.livenessProbeIntervalMs).toBe(DEFAULT_LIVENESS_PROBE_INTERVAL_MS);
    expect(orchestrator.probeLivenessMtimeFn).toBe(probeLivenessMtime);
  });

  it("does NOT kill a phase whose stdout is silent past the inactivity budget when its watched path keeps growing", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const probeLivenessMtimeFn = makeGrowingProbe();
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      phaseTimeoutMs: 60 * 60 * 1000,
      inactivityTimeoutMs: 1000,
      livenessProbeIntervalMs: 100,
      probeLivenessMtimeFn,
      writeRunStateFn: vi.fn(async () => {}),
      clearRunStateFn: vi.fn(async () => {})
    });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.start).toHaveBeenCalledTimes(1);

    // Five full inactivity windows' worth of elapsed silence on stdout -- the exact T-0274 shape --
    // with the watched path growing on every ~95ms-equivalent probe tick throughout.
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.kill).not.toHaveBeenCalled();
    expect(runner.start).toHaveBeenCalledTimes(1);
    expect((await store.get("T-0001")).status).toBe("in-progress");

    await driveToPass(runner, 0);
    await runPromise;
    expect((await store.get("T-0001")).status).toBe("review");
  });

  it("still kills the phase at the budget when neither stdout nor the mtime probe show any evidence (the stdin-hang case, unchanged)", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const probeLivenessMtimeFn = vi.fn(async () => null);
    const runLogs = [];
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      runLogs,
      phaseTimeoutMs: 60 * 60 * 1000,
      inactivityTimeoutMs: 1000,
      livenessProbeIntervalMs: 100,
      probeLivenessMtimeFn,
      writeRunStateFn: vi.fn(async () => {}),
      clearRunStateFn: vi.fn(async () => {})
    });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.advanceTimersByTimeAsync(0);
    const implChild = runner.spawnedChildren[0];

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.kill).toHaveBeenCalledWith(expect.objectContaining({ child: implChild }));
    expect(runner.start).toHaveBeenCalledTimes(2);
    const finalCheck = await store.get("T-0001");
    expect(finalCheck.status).toBe("in-progress");
    expect(finalCheck.body).toMatch(/implementer run went silent/i);
    expect(finalCheck.body).toMatch(/stdin-hang/i);

    const killEvents = runLogs[0].events.filter((e) => e.type === "liveness-kill");
    expect(killEvents).toHaveLength(1);
    expect(killEvents[0].message).toMatch(/no filesystem progress|no evidence/i);

    await driveToPass(runner, 1);
    await runPromise;
    expect((await store.get("T-0001")).status).toBe("review");
  });

  it("re-arms (not disables) on growth: once filesystem progress stops, the phase is killed one full budget later, not never", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const runLogs = [];
    const probeLivenessMtimeFn = makeGrowingProbe();
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      runLogs,
      phaseTimeoutMs: 60 * 60 * 1000,
      inactivityTimeoutMs: 1000,
      livenessProbeIntervalMs: 100,
      probeLivenessMtimeFn,
      writeRunStateFn: vi.fn(async () => {}),
      clearRunStateFn: vi.fn(async () => {})
    });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.advanceTimersByTimeAsync(0);
    const implChild = runner.spawnedChildren[0];

    // Three probe ticks' worth of real growth -- the last re-arm lands at t=300, extending the
    // deadline to t=1300.
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(0);
    probeLivenessMtimeFn.stopGrowing();

    const reprieveEvents = runLogs[0].events.filter((e) => e.type === "liveness-reprieve");
    expect(reprieveEvents.length).toBeGreaterThan(0);
    expect(reprieveEvents[0].message).toContain("/repo/worktrees/T-0001");
    expect(reprieveEvents[0].phase).toBe("implementer");

    // Just short of one full budget (1000ms) after the last real reprieve (t=300 -> deadline 1300):
    // not killed yet.
    await vi.advanceTimersByTimeAsync(999);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.kill).not.toHaveBeenCalled();

    // Past t=1300: killed exactly one budget after growth stopped, same as the no-evidence case.
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.kill).toHaveBeenCalledWith(expect.objectContaining({ child: implChild }));

    const killEvents = runLogs[0].events.filter((e) => e.type === "liveness-kill");
    expect(killEvents).toHaveLength(1);
    expect(killEvents[0].message).toContain("/repo/worktrees/T-0001");

    await driveToPass(runner, 1);
    await runPromise;
    expect((await store.get("T-0001")).status).toBe("review");
  });

  it("does not crash the phase when the mtime probe itself rejects on every call -- degrades to the stdout-only behavior", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const probeLivenessMtimeFn = vi.fn(async () => {
      throw new Error("stat exploded");
    });
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      phaseTimeoutMs: 60 * 60 * 1000,
      inactivityTimeoutMs: 1000,
      livenessProbeIntervalMs: 100,
      probeLivenessMtimeFn,
      writeRunStateFn: vi.fn(async () => {}),
      clearRunStateFn: vi.fn(async () => {})
    });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.advanceTimersByTimeAsync(0);
    const implChild = runner.spawnedChildren[0];

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.kill).toHaveBeenCalledWith(expect.objectContaining({ child: implChild }));

    await driveToPass(runner, 1);
    await runPromise;
    expect((await store.get("T-0001")).status).toBe("review");
  });

  it("treats an unchanging future-dated mtime as no new growth -- clock skew degrades safely instead of crashing or masking a real hang", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const FUTURE_MTIME_MS = 10_000_000_000_000;
    const probeLivenessMtimeFn = vi.fn(async () => ({ path: "/repo/worktrees/T-0001", mtimeMs: FUTURE_MTIME_MS }));
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      phaseTimeoutMs: 60 * 60 * 1000,
      inactivityTimeoutMs: 1000,
      livenessProbeIntervalMs: 100,
      probeLivenessMtimeFn,
      writeRunStateFn: vi.fn(async () => {}),
      clearRunStateFn: vi.fn(async () => {})
    });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.advanceTimersByTimeAsync(0);
    const implChild = runner.spawnedChildren[0];

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.kill).toHaveBeenCalledWith(expect.objectContaining({ child: implChild }));
    const finalCheck = await store.get("T-0001");
    expect(finalCheck.body).not.toMatch(/NaN/);

    await driveToPass(runner, 1);
    await runPromise;
  });

  it("keeps two concurrent runs' liveness independent -- growth on one task's worktree never re-arms a sibling task's deadline", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask({ id: "T-0001" }), baseTask({ id: "T-0002" })]);
    const git = makeGit();
    const runner = makeRunner();
    let growingMtime = 0;
    const probeLivenessMtimeFn = vi.fn(async ({ worktreeDir }) => {
      if (worktreeDir === "/repo/worktrees/T-0001") {
        growingMtime += 1;
        return { path: worktreeDir, mtimeMs: growingMtime };
      }
      return null;
    });
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      phaseTimeoutMs: 60 * 60 * 1000,
      inactivityTimeoutMs: 1000,
      livenessProbeIntervalMs: 100,
      probeLivenessMtimeFn,
      writeRunStateFn: vi.fn(async () => {}),
      clearRunStateFn: vi.fn(async () => {})
    });

    const run1 = orchestrator.runCard("T-0001");
    const run2 = orchestrator.runCard("T-0002");
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.start).toHaveBeenCalledTimes(2);
    const impl1 = runner.spawnedChildren[0];

    // T-0002 gets zero evidence on every attempt and exhausts its whole retry budget
    // (MAX_AUTO_RETRY_ATTEMPTS attempts, 1000ms inactivity budget each); T-0001 keeps growing
    // the entire time and must never see one of T-0002's kills bleed onto its own deadline.
    for (let attempt = 1; attempt <= MAX_AUTO_RETRY_ATTEMPTS; attempt++) {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);
    }
    await run2;

    expect(runner.kill).not.toHaveBeenCalledWith(expect.objectContaining({ child: impl1 }));
    expect((await store.get("T-0002")).status).toBe("blocked");
    expect((await store.get("T-0001")).status).toBe("in-progress");

    // T-0001's implementer is still the very first child ever spawned for it -- finish it up
    // by picking the next child to be spawned, whichever index that lands on now that T-0002
    // is done spawning any children of its own.
    impl1.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    const reviewChild1 = runner.spawnedChildren[runner.spawnedChildren.length - 1];
    reviewChild1.stdout.emit("data", ndjson(assistantEvent(`ok ${verdictBlock("PASS", "green")}`)));
    reviewChild1.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await run1;
    expect((await store.get("T-0001")).status).toBe("review");
  });
});
