import { describe, it, expect, vi, afterEach } from "vitest";
import { buildPrTitle, buildPrBody } from "../../src/runner/prBuilder.js";
import { EventEmitter } from "node:events";
import {
  RunOrchestrator,
  appendNote,
  MAX_AUTO_RETRY_ATTEMPTS,
  DEFAULT_PHASE_TIMEOUT_MS,
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  PR_OPEN_GRAPHQL_MAX_ATTEMPTS,
  PR_OPEN_REST_MAX_ATTEMPTS,
  PR_OPEN_BACKOFF_BASE_MS
} from "../../src/runner/runOrchestrator.js";
import { crossCheckVerdict } from "../../src/runner/verdictCrossCheck.js";

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

/** A rejected-createPr-style error pre-classified the way githubOps.classifyGhError would tag it. */
function ghErr(message, classification) {
  const err = new Error(message);
  err.ghClassification = classification;
  return err;
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

function makeGithub(overrides = {}) {
  return {
    checkAvailability: vi.fn(async () => ({ available: false, reason: "not-installed" })),
    findExistingPr: vi.fn(async () => null),
    createPr: vi.fn(async () => "https://github.com/example/repo/pull/1"),
    ...overrides
  };
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
    // Tests in this file aren't exercising the harness-side verdict cross-check (see
    // verdictCrossCheck.test.js for that in isolation, and the dedicated describe block below
    // for its wiring into the orchestrator) -- default to a passthrough so the fixture reviewer
    // events here (which rarely include the real Bash tool_use/tool_result pairs a genuine
    // verify route would produce) don't get spuriously downgraded out from under unrelated tests.
    crossCheckVerdictFn: ({ verdict }) => verdict,
    ...overrides
  });
}

function makeGit(overrides = {}) {
  return {
    addWorktree: vi.fn(async () => {}),
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

describe("RunOrchestrator.runCard — happy path (PASS)", () => {
  it("moves ready -> in-progress -> validation -> review, streams events, persists the run log, pushes on PASS", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const hub = { broadcast: vi.fn() };
    const runLogs = [];
    const orchestrator = makeOrchestrator({ store, git, runner, hub, runLogs });

    const runPromise = orchestrator.runCard("T-0001");

    const implChild = await nthChild(runner, 1);
    expect((await store.get("T-0001")).status).toBe("in-progress");
    implChild.stdout.emit("data", ndjson(assistantEvent("implementing...")));
    implChild.emit("exit", 0, null);

    const reviewChild = await nthChild(runner, 2);
    expect((await store.get("T-0001")).status).toBe("validation");
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`Reviewed. ${verdictBlock("PASS", "all green")}`)));
    reviewChild.emit("exit", 0, null);

    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
    expect(finalTask.body).toContain("all green");
    expect(finalTask.branch).toBe("feature/T-0001");
    expect(finalTask.commit).toBe("abc1234def5678abc1234def5678abc1234def5");

    expect(git.getHeadCommit).toHaveBeenCalledWith({ worktreeDir: "/repo/worktrees/T-0001" });

    expect(git.addWorktree).toHaveBeenCalledWith({
      repoRoot: "/repo",
      worktreeDir: "/repo/worktrees/T-0001",
      branch: "feature/T-0001",
      baseBranch: "develop"
    });
    expect(git.commitAll).toHaveBeenCalled();
    expect(git.push).toHaveBeenCalledWith({ worktreeDir: "/repo/worktrees/T-0001", branch: "feature/T-0001" });
    expect(git.removeWorktree).toHaveBeenCalledWith({ repoRoot: "/repo", worktreeDir: "/repo/worktrees/T-0001" });

    expect(runner.start).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: "sonnet", worktreeDir: "/repo/worktrees/T-0001" }));
    expect(runner.start).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: "opus", worktreeDir: "/repo/worktrees/T-0001" }));

    expect(runLogs).toHaveLength(1);
    expect(runLogs[0].events.length).toBeGreaterThanOrEqual(2);
    expect(runLogs[0].close).toHaveBeenCalledTimes(1);

    const runEventMessages = hub.broadcast.mock.calls.map(([msg]) => msg).filter((m) => m.type === "run-event");
    expect(runEventMessages.length).toBeGreaterThanOrEqual(2);
    expect(runEventMessages.every((m) => m.id === "T-0001")).toBe(true);
    expect(runEventMessages.some((m) => m.phase === "implementer")).toBe(true);
    expect(runEventMessages.some((m) => m.phase === "reviewer")).toBe(true);
  });
});

describe("RunOrchestrator.runCard — harness-side verdict cross-check (real crossCheckVerdictFn)", () => {
  /** verdictBlock's Bash tool_use companion: a real npm-test/eslint invocation with a tool_result. */
  function boardSuiteBashCall(id = "bash-1") {
    return [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id, name: "Bash", input: { command: "cd tools/board && npm test && npx eslint ." } }]
        }
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: "ok" }] } }
    ];
  }

  it("downgrades a self-reported PASS to FAIL -- and auto-retries instead of moving to review -- when the required verify command never ran", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit(); // diffNames defaults to ["tools/board/src/thing.js"] -> requires board-suite
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner, crossCheckVerdictFn: crossCheckVerdict });

    const runPromise = orchestrator.runCard("T-0001");

    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);

    const reviewChild = await nthChild(runner, 2);
    // Self-reports PASS, but never actually ran npm test / eslint via Bash.
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`Looks fine. ${verdictBlock("PASS", "all green")}`)));
    reviewChild.emit("exit", 0, null);

    // The downgrade routes this into the auto-retry loop, not review -- a third child (the
    // retried implementer) spawning is the observable proof PASS was not accepted.
    await nthChild(runner, 3);

    const midRetryTask = await store.get("T-0001");
    expect(midRetryTask.status).toBe("in-progress");
    expect(midRetryTask.status).not.toBe("review");
    expect(midRetryTask.body).toContain("## Validation: FAIL");
    expect(midRetryTask.body).toMatch(/downgraded by harness verdict cross-check/);
    expect(midRetryTask.body).toMatch(/Board test\/lint suite/);
    expect(git.push).not.toHaveBeenCalled();

    // Let the retry finish (as a crash, for simplicity) so runPromise resolves.
    runner.spawnedChildren[2].emit("exit", 1, null);
    await runPromise;
  });

  it("keeps a self-reported PASS as PASS -- and moves the card to review -- when the required verify command actually ran and exited zero", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner, crossCheckVerdictFn: crossCheckVerdict });

    const runPromise = orchestrator.runCard("T-0001");

    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);

    const reviewChild = await nthChild(runner, 2);
    for (const event of boardSuiteBashCall()) {
      reviewChild.stdout.emit("data", ndjson(event));
    }
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "ran npm test + eslint, both green"))));
    reviewChild.emit("exit", 0, null);

    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
    expect(finalTask.body).toContain("ran npm test + eslint, both green");
    expect(git.push).toHaveBeenCalled();
  });

  it("never upgrades a self-reported FAIL, even when the required verify command did run and pass", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner, crossCheckVerdictFn: crossCheckVerdict });

    const runPromise = orchestrator.runCard("T-0001");

    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);

    const reviewChild = await nthChild(runner, 2);
    for (const event of boardSuiteBashCall()) {
      reviewChild.stdout.emit("data", ndjson(event));
    }
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("FAIL", "unrelated lint nit in the diff"))));
    reviewChild.emit("exit", 0, null);

    await nthChild(runner, 3);

    const midRetryTask = await store.get("T-0001");
    expect(midRetryTask.status).toBe("in-progress");
    expect(midRetryTask.body).toContain("unrelated lint nit in the diff");
    expect(midRetryTask.body).not.toMatch(/downgraded by harness verdict cross-check/);

    runner.spawnedChildren[2].emit("exit", 1, null);
    await runPromise;
  });
});

describe("RunOrchestrator.runCard — links node_modules after worktree creation", () => {
  it("calls git.linkBoardNodeModules with the worktreeDir and repoRoot after addWorktree succeeds", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");

    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);

    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`ok ${verdictBlock("PASS", "green")}`)));
    reviewChild.emit("exit", 0, null);

    await runPromise;

    expect(git.linkBoardNodeModules).toHaveBeenCalledWith({
      worktreeDir: "/repo/worktrees/T-0001",
      repoRoot: "/repo"
    });
  });
});

describe("RunOrchestrator.runCard — routes the reviewer's changed paths through to the validation gate", () => {
  it("passes the diff's changed paths (from git.diffNames) into the reviewer prompt builder -- a planner diff", async () => {
    const store = makeStore([baseTask({ agent: "planner" })]);
    const git = makeGit({ diffNames: vi.fn(async () => ["tasks/T-0200.md"]) });
    const runner = makeRunner();
    const buildReviewerPromptFn = vi.fn(() => "reviewer prompt");
    const orchestrator = makeOrchestrator({ store, git, runner, buildReviewerPromptFn });

    const runPromise = orchestrator.runCard("T-0001");

    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);

    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`ok ${verdictBlock("PASS", "backlog validates")}`)));
    reviewChild.emit("exit", 0, null);

    await runPromise;

    expect(buildReviewerPromptFn).toHaveBeenCalledWith(
      expect.objectContaining({ changedPaths: ["tasks/T-0200.md"] })
    );
  });

  it("passes a code diff's changed paths through unchanged -- code work keeps its own tests/lint/build routing", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit({ diffNames: vi.fn(async () => ["tools/board/src/lib/fsTaskStore.js"]) });
    const runner = makeRunner();
    const buildReviewerPromptFn = vi.fn(() => "reviewer prompt");
    const orchestrator = makeOrchestrator({ store, git, runner, buildReviewerPromptFn });

    const runPromise = orchestrator.runCard("T-0001");

    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);

    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`ok ${verdictBlock("PASS", "suite green")}`)));
    reviewChild.emit("exit", 0, null);

    await runPromise;

    expect(buildReviewerPromptFn).toHaveBeenCalledWith(
      expect.objectContaining({ changedPaths: ["tools/board/src/lib/fsTaskStore.js"] })
    );
  });

  it("passes its own baseBranch through to the reviewer prompt builder, for the diff guard's base ref", async () => {
    const store = makeStore([baseTask({ agent: "planner" })]);
    const git = makeGit({ diffNames: vi.fn(async () => ["tasks/T-0200.md"]) });
    const runner = makeRunner();
    const buildReviewerPromptFn = vi.fn(() => "reviewer prompt");
    const orchestrator = makeOrchestrator({ store, git, runner, buildReviewerPromptFn, baseBranch: "develop" });

    const runPromise = orchestrator.runCard("T-0001");

    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);

    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`ok ${verdictBlock("PASS", "backlog validates")}`)));
    reviewChild.emit("exit", 0, null);

    await runPromise;

    expect(buildReviewerPromptFn).toHaveBeenCalledWith(expect.objectContaining({ baseBranch: "develop" }));
  });
});

describe("RunOrchestrator.runCard — FAIL validation triggers a bounded auto-retry, not a dead end", () => {
  it("on FAIL, appends the reviewer's reasons to the body but keeps the card running (not blocked) while it auto-retries the implementer", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");

    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);

    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit(
      "data",
      ndjson(assistantEvent(`Found issues. ${verdictBlock("FAIL", "missing test at src/foo.js:12")}`))
    );
    reviewChild.emit("exit", 0, null);

    // A second implementer attempt starts on its own -- no second runCard() call, no click.
    await nthChild(runner, 3);

    const midRetryTask = await store.get("T-0001");
    expect(midRetryTask.status).toBe("in-progress");
    expect(midRetryTask.status).not.toBe("blocked");
    expect(midRetryTask.body).toContain("## Validation: FAIL");
    expect(midRetryTask.body).toContain("missing test at src/foo.js:12");
    expect(midRetryTask.body).toContain("run 1 of 5");
    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();

    // Let the retry finish (as a crash, for simplicity) so runPromise resolves.
    runner.spawnedChildren[2].emit("exit", 1, null);
    await runPromise;
  });
});

describe("RunOrchestrator.runCard — auto-retry loop on reviewer FAIL (bounded)", () => {
  /** Drives the nth implementer+reviewer cycle to a FAIL verdict; assumes the implementer has already been spawned or is about to be. */
  async function driveFailCycle(runner, n) {
    const implChild = await nthChild(runner, n * 2 - 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, n * 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("FAIL", `issue round ${n}`))));
    reviewChild.emit("exit", 0, null);
    return { implChild, reviewChild };
  }

  it("automatically re-runs the implementer on the same worktree/branch after a FAIL -- an in-process call, not a status a human has to click", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit({ addWorktree: vi.fn(async () => ({ reused: false })) });
    const runner = makeRunner();
    const buildPromptFn = vi.fn(() => "prompt");
    const orchestrator = makeOrchestrator({ store, git, runner, buildPromptFn });

    const runPromise = orchestrator.runCard("T-0001");
    await driveFailCycle(runner, 1);

    const implChild2 = await nthChild(runner, 3);
    expect((await store.get("T-0001")).status).toBe("in-progress");
    expect(git.addWorktree).toHaveBeenCalledTimes(1);

    implChild2.emit("exit", 0, null);
    const reviewChild2 = await nthChild(runner, 4);
    reviewChild2.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fixed"))));
    reviewChild2.emit("exit", 0, null);
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
    // The retry resumes the same branch with the FAIL note (now in the body) injected.
    expect(buildPromptFn.mock.calls[1][0]).toMatchObject({ continuing: true });
    expect(buildPromptFn.mock.calls[1][0].task.body).toContain("issue round 1");
  });

  it(`caps auto-retry at ${MAX_AUTO_RETRY_ATTEMPTS} total runs -- the final consecutive FAIL blocks the card and stops retrying`, async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    for (let n = 1; n <= MAX_AUTO_RETRY_ATTEMPTS; n++) {
      await driveFailCycle(runner, n);
    }
    await runPromise;

    // 5 implementer + 5 reviewer runs, and never a 6th implementer attempt.
    expect(runner.start).toHaveBeenCalledTimes(MAX_AUTO_RETRY_ATTEMPTS * 2);
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.attempts).toBe(MAX_AUTO_RETRY_ATTEMPTS);
    expect(finalTask.body).toContain(`run ${MAX_AUTO_RETRY_ATTEMPTS} of ${MAX_AUTO_RETRY_ATTEMPTS}`);
    expect(finalTask.body).toMatch(/auto-retry limit reached/i);
    expect(finalTask.body).toContain("issue round 1");
    expect(finalTask.body).toContain(`issue round ${MAX_AUTO_RETRY_ATTEMPTS}`);
  });

  it('includes the attempt count ("run N of 5") in every FAIL note', async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await driveFailCycle(runner, 1);
    const implChild2 = await nthChild(runner, 3);
    implChild2.emit("exit", 0, null);
    const reviewChild2 = await nthChild(runner, 4);
    reviewChild2.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fixed"))));
    reviewChild2.emit("exit", 0, null);
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.body).toContain("run 1 of 5");
  });

  it("persists the attempts counter on the task after each attempt (visible in the task JSON for the UI)", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild1 = await nthChild(runner, 1);
    expect((await store.get("T-0001")).attempts).toBe(1);
    implChild1.emit("exit", 0, null);

    const reviewChild1 = await nthChild(runner, 2);
    reviewChild1.stdout.emit("data", ndjson(assistantEvent(verdictBlock("FAIL", "x"))));
    reviewChild1.emit("exit", 0, null);

    const implChild2 = await nthChild(runner, 3);
    expect((await store.get("T-0001")).attempts).toBe(2);
    implChild2.emit("exit", 1, null);
    await runPromise;
  });

  it("resets the attempts counter to 0 on PASS, even after prior FAILs", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await driveFailCycle(runner, 1);
    const implChild2 = await nthChild(runner, 3);
    implChild2.emit("exit", 0, null);
    const reviewChild2 = await nthChild(runner, 4);
    reviewChild2.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fixed"))));
    reviewChild2.emit("exit", 0, null);
    await runPromise;

    expect((await store.get("T-0001")).attempts).toBe(0);
  });

  it("gives a card a fresh auto-retry allowance on a human-initiated run, even if it previously exhausted all 5 attempts", async () => {
    const store = makeStore([baseTask({ status: "blocked", attempts: MAX_AUTO_RETRY_ATTEMPTS, branch: "feature/T-0001" })]);
    const git = makeGit({ addWorktree: vi.fn(async () => ({ reused: true })) });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    // Reset to 0, then this attempt bumps it to 1 -- not left at (or incremented past) 5.
    expect((await store.get("T-0001")).attempts).toBe(1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fixed"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect((await store.get("T-0001")).status).toBe("review");
  });

  it("refuses a concurrent run while an auto-retry cycle is between the reviewer's FAIL and the next implementer attempt (re-entrancy guard)", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await driveFailCycle(runner, 1);

    // Mid-retry-cycle: the next implementer attempt hasn't spawned yet (activeRuns is
    // momentarily empty here), but activeCardIds still holds the card -- must still reject.
    await expect(orchestrator.runCard("T-0001")).rejects.toThrow(/active run|status is "/i);

    const implChild2 = await nthChild(runner, 3);
    implChild2.emit("exit", 1, null);
    await runPromise;
  });
});

describe("RunOrchestrator.runCard — runner failures become blocked, not a graded verdict", () => {
  it("worktree creation failure never touches the card's status away from ready", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit({ addWorktree: vi.fn(async () => { throw new Error("disk full"); }) });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    await orchestrator.runCard("T-0001");

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.body).toContain("worktree creation failed");
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("a non-zero implementer exit code blocks the card and preserves the worktree", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 1, null);
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.body).toMatch(/exit(ed)? (with code )?1/i);
    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  it("a non-zero reviewer exit code blocks the card rather than guessing a verdict", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.emit("exit", 1, null);
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.body).toMatch(/reviewer/i);
  });

  it("a reviewer run with no machine-readable verdict block blocks the card", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent("I reviewed it but forgot the verdict block.")));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.body).toMatch(/verdict/i);
  });

  it("an implementer spawn failure (e.g. ENOENT) blocks the card instead of crashing the board or hanging the run", async () => {
    // T-0185 incident: spawn('claude', ...) failed with ENOENT (the CLI wasn't resolvable on
    // the child's PATH) and the resulting unlistened child 'error' event crashed the whole
    // board process. This exercises the orchestrator's own once("error", ...) listener (see
    // _runPhase) -- the ordinary case where it attaches before the error fires.
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.body).toMatch(/failed to start/i);
    expect(finalTask.body).toMatch(/spawn claude enoent/i);
  });

  it("a spawn failure captured on run.spawnError before this orchestrator's own listener attaches still blocks the card promptly, not a hang until phaseTimeoutMs", async () => {
    // Reproduces the actual race that caused the crash: ClaudeCliRunner.start() attaches its
    // 'error' listener synchronously at spawn time, so a fast ENOENT can already be captured
    // onto run.spawnError by the time _runPhase's own writeRunStateFn await finishes -- well
    // before _runPhase gets around to attaching its own once("error", ...) listener, which
    // would otherwise never see an event that already fired.
    const spawnError = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const spawnedChildren = [];
    const start = vi.fn(async () => {
      const child = fakeChildProcess();
      spawnedChildren.push(child);
      return { runId: "run", child, spawnError };
    });
    const runner = { start, kill: vi.fn((run) => run.child.kill()), spawnedChildren };
    const orchestrator = makeOrchestrator({ store, git, runner });

    await orchestrator.runCard("T-0001");

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.body).toMatch(/failed to start/i);
    expect(finalTask.body).toMatch(/spawn claude enoent/i);
  });
});

describe("RunOrchestrator.runCard — phase-level timeout (hung child protection, T-0185)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports a generous, named default phase timeout", () => {
    expect(DEFAULT_PHASE_TIMEOUT_MS).toBeGreaterThanOrEqual(30 * 60 * 1000);
    expect(DEFAULT_PHASE_TIMEOUT_MS).toBeLessThanOrEqual(45 * 60 * 1000);
  });

  it("kills the implementer's whole process group and blocks the card when the implementer phase exceeds phaseTimeoutMs, without retrying", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner, phaseTimeoutMs: 1000, writeRunStateFn: vi.fn(async () => {}), clearRunStateFn: vi.fn(async () => {}) });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.start).toHaveBeenCalledTimes(1);
    const implChild = runner.spawnedChildren[0];

    await vi.advanceTimersByTimeAsync(1000);
    await runPromise;

    expect(runner.kill).toHaveBeenCalledWith(expect.objectContaining({ child: implChild }));

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.body).toMatch(/implementer/i);
    expect(finalTask.body).toMatch(/timed? ?out|exceeded/i);
    // Deliberately NOT "hung subprocess" any more -- see the message describe block
    // below. The phase watchdog cannot tell an overrun from a hang, and asserting a
    // hang sent the T-0228 diagnosis down the wrong path for two runs.
    expect(finalTask.body).not.toContain("hung subprocess");

    // A timeout is a hard stop, not a graded FAIL -- it must not feed the auto-retry loop.
    expect(runner.start).toHaveBeenCalledTimes(1);
    expect(orchestrator.hasActiveRuns()).toBe(false);
  });

  it("kills the reviewer's whole process group and blocks the card when the reviewer phase exceeds phaseTimeoutMs", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner, phaseTimeoutMs: 1000, writeRunStateFn: vi.fn(async () => {}), clearRunStateFn: vi.fn(async () => {}) });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.advanceTimersByTimeAsync(0);
    const implChild = runner.spawnedChildren[0];
    implChild.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.start).toHaveBeenCalledTimes(2);
    const reviewChild = runner.spawnedChildren[1];

    await vi.advanceTimersByTimeAsync(1000);
    await runPromise;

    expect(runner.kill).toHaveBeenCalledWith(expect.objectContaining({ child: reviewChild }));

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.body).toMatch(/reviewer/i);
    expect(finalTask.body).toMatch(/timed? ?out|exceeded/i);

    expect(runner.start).toHaveBeenCalledTimes(2);
    expect(orchestrator.hasActiveRuns()).toBe(false);
  });

  it("does not time out a phase that finishes comfortably inside phaseTimeoutMs", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner, phaseTimeoutMs: 60_000, writeRunStateFn: vi.fn(async () => {}), clearRunStateFn: vi.fn(async () => {}) });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.advanceTimersByTimeAsync(0);
    const implChild = runner.spawnedChildren[0];
    implChild.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    const reviewChild = runner.spawnedChildren[1];
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`Reviewed. ${verdictBlock("PASS", "all green")}`)));
    reviewChild.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
    expect(runner.kill).not.toHaveBeenCalled();
  });
});

describe("RunOrchestrator.runCard — inactivity watchdog (stdin-hang hardening, T-0117)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports a generous default inactivity window, well tighter than the phase timeout", () => {
    expect(DEFAULT_INACTIVITY_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(DEFAULT_INACTIVITY_TIMEOUT_MS).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(DEFAULT_INACTIVITY_TIMEOUT_MS).toBeLessThan(DEFAULT_PHASE_TIMEOUT_MS);
  });

  it("kills the implementer's process group when its stdout goes silent for inactivityTimeoutMs, and retries instead of hard-blocking", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      phaseTimeoutMs: 60 * 60 * 1000,
      inactivityTimeoutMs: 1000,
      writeRunStateFn: vi.fn(async () => {}),
      clearRunStateFn: vi.fn(async () => {})
    });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.start).toHaveBeenCalledTimes(1);
    const implChild = runner.spawnedChildren[0];

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.kill).toHaveBeenCalledWith(expect.objectContaining({ child: implChild }));
    // Not a hard block: the auto-retry loop already re-invoked the implementer on attempt 2.
    expect(runner.start).toHaveBeenCalledTimes(2);
    expect((await store.get("T-0001")).status).toBe("in-progress");

    const secondImplChild = runner.spawnedChildren[1];
    secondImplChild.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    const reviewChild = runner.spawnedChildren[2];
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`Reviewed. ${verdictBlock("PASS", "all green")}`)));
    reviewChild.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
    expect(finalTask.body).toMatch(/implementer run went silent/i);
    expect(finalTask.body).toMatch(/stdin-hang/i);
    expect(finalTask.body).toMatch(/run 1 of 5/i);
    expect(orchestrator.hasActiveRuns()).toBe(false);
  });

  it("kills the reviewer's process group on silence too, and retries from the implementer on the next attempt", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      phaseTimeoutMs: 60 * 60 * 1000,
      inactivityTimeoutMs: 1000,
      writeRunStateFn: vi.fn(async () => {}),
      clearRunStateFn: vi.fn(async () => {})
    });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.advanceTimersByTimeAsync(0);
    const implChild = runner.spawnedChildren[0];
    implChild.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    const reviewChild = runner.spawnedChildren[1];

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.kill).toHaveBeenCalledWith(expect.objectContaining({ child: reviewChild }));
    expect(runner.start).toHaveBeenCalledTimes(3);

    const secondImplChild = runner.spawnedChildren[2];
    secondImplChild.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    const secondReviewChild = runner.spawnedChildren[3];
    secondReviewChild.stdout.emit("data", ndjson(assistantEvent(`Reviewed. ${verdictBlock("PASS", "all green")}`)));
    secondReviewChild.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
    expect(finalTask.body).toMatch(/reviewer run went silent/i);
  });

  it("does not false-positive on a run that keeps producing output across multiple re-arm windows", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      phaseTimeoutMs: 60 * 60 * 1000,
      inactivityTimeoutMs: 1000,
      writeRunStateFn: vi.fn(async () => {}),
      clearRunStateFn: vi.fn(async () => {})
    });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.advanceTimersByTimeAsync(0);
    const implChild = runner.spawnedChildren[0];

    // Three windows' worth of elapsed time, each reset by fresh output just before the deadline.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(800);
      implChild.stdout.emit("data", ndjson(assistantEvent(`still working ${i}`)));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.kill).not.toHaveBeenCalled();
    expect(runner.start).toHaveBeenCalledTimes(1);

    implChild.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    const reviewChild = runner.spawnedChildren[1];
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`Reviewed. ${verdictBlock("PASS", "all green")}`)));
    reviewChild.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
    expect(runner.kill).not.toHaveBeenCalled();
  });

  it("exhausts MAX_AUTO_RETRY_ATTEMPTS on repeated inactivity timeouts and blocks the card for a human, same as a real reviewer FAIL", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      phaseTimeoutMs: 60 * 60 * 1000,
      inactivityTimeoutMs: 1000,
      writeRunStateFn: vi.fn(async () => {}),
      clearRunStateFn: vi.fn(async () => {})
    });

    const runPromise = orchestrator.runCard("T-0001");
    for (let attempt = 1; attempt <= MAX_AUTO_RETRY_ATTEMPTS; attempt++) {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);
    }
    await runPromise;

    expect(runner.start).toHaveBeenCalledTimes(MAX_AUTO_RETRY_ATTEMPTS);
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.body).toMatch(/auto-retry limit reached/i);
    expect(orchestrator.hasActiveRuns()).toBe(false);
  });

  it("respects the INACTIVITY_TIMEOUT_MS env override", () => {
    const original = process.env.INACTIVITY_TIMEOUT_MS;
    try {
      process.env.INACTIVITY_TIMEOUT_MS = "12345";
      const store = makeStore([baseTask()]);
      const git = makeGit();
      const runner = makeRunner();
      const orchestrator = makeOrchestrator({ store, git, runner });
      expect(orchestrator.inactivityTimeoutMs).toBe(12345);
    } finally {
      if (original === undefined) delete process.env.INACTIVITY_TIMEOUT_MS;
      else process.env.INACTIVITY_TIMEOUT_MS = original;
    }
  });
});

describe("RunOrchestrator.runCard — guardrails", () => {
  it("refuses to run a card that is not in ready or review status", async () => {
    const store = makeStore([baseTask({ status: "in-progress" })]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    await expect(orchestrator.runCard("T-0001")).rejects.toThrow(/ready/i);
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it("refuses to run a retired card", async () => {
    const store = makeStore([baseTask({ status: "retired" })]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    await expect(orchestrator.runCard("T-0001")).rejects.toThrow(/ready/i);
    expect(git.addWorktree).not.toHaveBeenCalled();
  });

  it("refuses a second concurrent run of the same card", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const first = orchestrator.runCard("T-0001");
    await nthChild(runner, 1);

    await expect(orchestrator.runCard("T-0001")).rejects.toThrow(/active run|status is "in-progress"/i);

    const implChild = runner.spawnedChildren[0];
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "ok"))));
    reviewChild.emit("exit", 0, null);
    await first;
  });

  it("never issues a transition that could land the card on done", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "ok"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    for (const task of store.tasks.values()) {
      expect(task.status).not.toBe("done");
    }
  });
});

describe("RunOrchestrator.runCard — re-run continues existing work instead of wiping (Feature B)", () => {
  it("accepts a run on a review-status card (re-run after review, not just ready)", async () => {
    const store = makeStore([baseTask({ status: "review", branch: "feature/T-0001" })]);
    const git = makeGit({ addWorktree: vi.fn(async () => ({ reused: true })) });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fixed"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(git.addWorktree).toHaveBeenCalledWith({
      repoRoot: "/repo",
      worktreeDir: "/repo/worktrees/T-0001",
      branch: "feature/T-0001",
      baseBranch: "develop"
    });
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
  });

  it("passes continuing: true and the card's comments to the prompt builder when addWorktree reuses an existing branch", async () => {
    const comments = [{ author: "Dennie", text: "CI failed, please fix", timestamp: "2026-08-05T12:00:00.000Z" }];
    const store = makeStore([baseTask({ status: "review", comments })]);
    const git = makeGit({ addWorktree: vi.fn(async () => ({ reused: true })) });
    const runner = makeRunner();
    const buildPromptFn = vi.fn(() => "continue prompt");
    const orchestrator = makeOrchestrator({ store, git, runner, buildPromptFn });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 1, null);
    await runPromise;

    expect(buildPromptFn).toHaveBeenCalledWith(
      expect.objectContaining({ continuing: true, comments })
    );
  });

  it("passes continuing: false when addWorktree cuts a fresh branch (reused: false)", async () => {
    const store = makeStore([baseTask({ status: "ready" })]);
    const git = makeGit({ addWorktree: vi.fn(async () => ({ reused: false })) });
    const runner = makeRunner();
    const buildPromptFn = vi.fn(() => "fresh prompt");
    const orchestrator = makeOrchestrator({ store, git, runner, buildPromptFn });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 1, null);
    await runPromise;

    expect(buildPromptFn).toHaveBeenCalledWith(
      expect.objectContaining({ continuing: false, comments: [] })
    );
  });

  it("treats a missing/undefined addWorktree return value as not reused (back-compat with a bare mock)", async () => {
    const store = makeStore([baseTask({ status: "ready" })]);
    const git = makeGit({ addWorktree: vi.fn(async () => undefined) });
    const runner = makeRunner();
    const buildPromptFn = vi.fn(() => "fresh prompt");
    const orchestrator = makeOrchestrator({ store, git, runner, buildPromptFn });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 1, null);
    await runPromise;

    expect(buildPromptFn).toHaveBeenCalledWith(expect.objectContaining({ continuing: false }));
  });

  it("force-pushes (force: true) on PASS when the run continued an existing (reused) branch", async () => {
    const store = makeStore([baseTask({ status: "review" })]);
    const git = makeGit({ addWorktree: vi.fn(async () => ({ reused: true })) });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fixed"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(git.push).toHaveBeenCalledWith({
      worktreeDir: "/repo/worktrees/T-0001",
      branch: "feature/T-0001",
      force: true
    });
  });

  it("does not force-push on PASS for a normal fresh-branch run (reused: false)", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit({ addWorktree: vi.fn(async () => ({ reused: false })) });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "all green"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(git.push).toHaveBeenCalledWith({
      worktreeDir: "/repo/worktrees/T-0001",
      branch: "feature/T-0001"
    });
  });

  it("on re-run PASS, reuses the existing PR instead of opening a duplicate (findExistingPr idempotency)", async () => {
    const store = makeStore([baseTask({ status: "review", pr: "https://github.com/example/repo/pull/55" })]);
    const git = makeGit({ addWorktree: vi.fn(async () => ({ reused: true })) });
    const runner = makeRunner();
    const github = makeGithub({
      checkAvailability: vi.fn(async () => ({ available: true, reason: null })),
      findExistingPr: vi.fn(async () => "https://github.com/example/repo/pull/55")
    });
    const orchestrator = makeOrchestrator({ store, git, runner, github });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fixed"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(github.createPr).not.toHaveBeenCalled();
    const finalTask = await store.get("T-0001");
    expect(finalTask.pr).toBe("https://github.com/example/repo/pull/55");
  });
});

describe("RunOrchestrator.runCard — blocked cards re-run continues existing work instead of wiping", () => {
  it("accepts a run on a blocked-status card with an existing branch, reusing it rather than starting over", async () => {
    const store = makeStore([
      baseTask({ status: "blocked", branch: "feature/T-0001", body: "## Context\nDo it.\n\n## Blocked (2026-08-04T00:00:00.000Z)\n\nworktree creation failed: boom\n" })
    ]);
    const git = makeGit({ addWorktree: vi.fn(async () => ({ reused: true })) });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fixed the blocker"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(git.addWorktree).toHaveBeenCalledWith({
      repoRoot: "/repo",
      worktreeDir: "/repo/worktrees/T-0001",
      branch: "feature/T-0001",
      baseBranch: "develop"
    });
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
  });

  it("passes continuing: true, the block reason (in the task body), and the card's comments to the implementer prompt on a reused blocked re-run", async () => {
    const comments = [{ author: "Dennie", text: "the worktree issue is fixed now, retry", timestamp: "2026-08-05T12:00:00.000Z" }];
    const blockedBody = "## Context\nDo it.\n\n## Blocked (2026-08-04T00:00:00.000Z)\n\nreviewer did not produce a machine-readable verdict\n";
    const store = makeStore([baseTask({ status: "blocked", body: blockedBody, comments })]);
    const git = makeGit({ addWorktree: vi.fn(async () => ({ reused: true })) });
    const runner = makeRunner();
    const buildPromptFn = vi.fn(() => "continue prompt");
    const orchestrator = makeOrchestrator({ store, git, runner, buildPromptFn });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 1, null);
    await runPromise;

    expect(buildPromptFn).toHaveBeenCalledWith(
      expect.objectContaining({
        continuing: true,
        comments,
        task: expect.objectContaining({ body: blockedBody })
      })
    );
  });

  it("re-runs a blocked card with no existing branch/work cleanly as a fresh start, not an error", async () => {
    const store = makeStore([baseTask({ status: "blocked", branch: undefined, body: "## Context\nDo it.\n\n## Blocked (2026-08-04T00:00:00.000Z)\n\nworktree creation failed before any commit\n" })]);
    const git = makeGit({ addWorktree: vi.fn(async () => ({ reused: false })) });
    const runner = makeRunner();
    const buildPromptFn = vi.fn(() => "fresh prompt");
    const orchestrator = makeOrchestrator({ store, git, runner, buildPromptFn });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "clean start"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(buildPromptFn).toHaveBeenCalledWith(expect.objectContaining({ continuing: false, comments: [] }));
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
  });

  it("force-pushes on PASS when a blocked re-run continued an existing (reused) branch", async () => {
    const store = makeStore([baseTask({ status: "blocked" })]);
    const git = makeGit({ addWorktree: vi.fn(async () => ({ reused: true })) });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fixed"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(git.push).toHaveBeenCalledWith({
      worktreeDir: "/repo/worktrees/T-0001",
      branch: "feature/T-0001",
      force: true
    });
  });

  it("reuses an existing PR (findExistingPr) rather than opening a new one when a blocked re-run passes", async () => {
    const store = makeStore([baseTask({ status: "blocked", pr: "https://github.com/example/repo/pull/55" })]);
    const git = makeGit({ addWorktree: vi.fn(async () => ({ reused: true })) });
    const runner = makeRunner();
    const github = makeGithub({
      checkAvailability: vi.fn(async () => ({ available: true, reason: null })),
      findExistingPr: vi.fn(async () => "https://github.com/example/repo/pull/55")
    });
    const orchestrator = makeOrchestrator({ store, git, runner, github });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "fixed"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(github.createPr).not.toHaveBeenCalled();
    const finalTask = await store.get("T-0001");
    expect(finalTask.pr).toBe("https://github.com/example/repo/pull/55");
  });
});

describe("RunOrchestrator.runCard — finalize: auto-open PR on PASS", () => {
  it("(a) on PASS, opens a PR via gh with base=develop, head=feature/T-XXXX, and a non-empty title/body", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const github = makeGithub({ checkAvailability: vi.fn(async () => ({ available: true, reason: null })) });
    const orchestrator = makeOrchestrator({ store, git, runner, github });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "suite green"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(github.createPr).toHaveBeenCalledTimes(1);
    const call = github.createPr.mock.calls[0][0];
    expect(call.base).toBe("develop");
    expect(call.head).toBe("feature/T-0001");
    expect(call.title).toBeTruthy();
    expect(call.body).toBeTruthy();
  });

  it("(b) when gh is unavailable (not installed or not authenticated), the run still succeeds and logs a skip instead of throwing", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const hub = { broadcast: vi.fn() };
    const github = makeGithub({ checkAvailability: vi.fn(async () => ({ available: false, reason: "not-authenticated" })) });
    const orchestrator = makeOrchestrator({ store, git, runner, hub, github });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "suite green"))));
    reviewChild.emit("exit", 0, null);
    await expect(runPromise).resolves.not.toThrow();

    expect(github.createPr).not.toHaveBeenCalled();
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
    expect(finalTask.pr).toBeFalsy();

    const finalizeMessages = hub.broadcast.mock.calls
      .map(([msg]) => msg)
      .filter((m) => m.type === "run-event" && m.phase === "finalize");
    expect(finalizeMessages.some((m) => /gh not authenticated/i.test(m.event.message))).toBe(true);
  });

  it("(c) when a PR already exists for the branch, reuses its URL instead of creating a duplicate", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const github = makeGithub({
      checkAvailability: vi.fn(async () => ({ available: true, reason: null })),
      findExistingPr: vi.fn(async () => "https://github.com/example/repo/pull/55")
    });
    const orchestrator = makeOrchestrator({ store, git, runner, github });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "suite green"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(github.createPr).not.toHaveBeenCalled();
    const finalTask = await store.get("T-0001");
    expect(finalTask.pr).toBe("https://github.com/example/repo/pull/55");
  });

  it("(c2) when the card's recorded PR is stale/closed (findExistingPr correctly reports it absent), opens a fresh PR and overwrites the dead pr field -- T-0287", async () => {
    const store = makeStore([baseTask({ pr: "https://github.com/example/repo/pull/271" })]);
    const git = makeGit();
    const runner = makeRunner();
    const github = makeGithub({
      checkAvailability: vi.fn(async () => ({ available: true, reason: null })),
      // A closed PR is not live for this branch -- githubOps.findExistingPr's liveness check
      // (state === OPEN, headRefName matches) resolves this to null, same as no PR at all.
      findExistingPr: vi.fn(async () => null),
      createPr: vi.fn(async () => "https://github.com/example/repo/pull/312")
    });
    const orchestrator = makeOrchestrator({ store, git, runner, github });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "suite green"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(github.createPr).toHaveBeenCalledTimes(1);
    const finalTask = await store.get("T-0001");
    expect(finalTask.pr).toBe("https://github.com/example/repo/pull/312");
    expect(finalTask.pr).not.toBe("https://github.com/example/repo/pull/271");
  });

  it("(d) a FAIL verdict never opens a PR, even after the auto-retry loop exhausts its attempts and blocks the card", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const github = makeGithub({ checkAvailability: vi.fn(async () => ({ available: true, reason: null })) });
    const orchestrator = makeOrchestrator({ store, git, runner, github });

    const runPromise = orchestrator.runCard("T-0001");
    for (let n = 1; n <= MAX_AUTO_RETRY_ATTEMPTS; n++) {
      const implChild = await nthChild(runner, n * 2 - 1);
      implChild.emit("exit", 0, null);
      const reviewChild = await nthChild(runner, n * 2);
      // Distinct notes per attempt -- this test exercises the auto-retry cap itself, not
      // the §23-a no-progress abort (see runOrchestrator.noProgressAbort.test.js for that),
      // so every attempt must hash to a different failure signature to reach the cap.
      reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("FAIL", `missing test (round ${n})`))));
      reviewChild.emit("exit", 0, null);
    }
    await runPromise;

    expect((await store.get("T-0001")).status).toBe("blocked");
    expect(github.checkAvailability).not.toHaveBeenCalled();
    expect(github.createPr).not.toHaveBeenCalled();
  });

  it("(e) on success, the PR URL is recorded on the card: pr frontmatter field and a ## PR body note", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const github = makeGithub({
      checkAvailability: vi.fn(async () => ({ available: true, reason: null })),
      createPr: vi.fn(async () => "https://github.com/example/repo/pull/77")
    });
    const orchestrator = makeOrchestrator({ store, git, runner, github });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "suite green"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.pr).toBe("https://github.com/example/repo/pull/77");
    expect(finalTask.body).toContain("https://github.com/example/repo/pull/77");
  });

  it("composes the PR title/body from the card's own fields and the reviewer's verdict notes", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const github = makeGithub({ checkAvailability: vi.fn(async () => ({ available: true, reason: null })) });
    const orchestrator = makeOrchestrator({ store, git, runner, github });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "npm test: 611 passed"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    const task = baseTask();
    const verdict = { verdict: "PASS", notes: "npm test: 611 passed" };
    const call = github.createPr.mock.calls[0][0];
    expect(call.title).toBe(buildPrTitle({ task }));
    expect(call.body).toBe(buildPrBody({ task, verdict }));
  });

  it("respects autoOpenPr: false (AUTO_OPEN_PR config flag) by never contacting gh", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const github = makeGithub({ checkAvailability: vi.fn(async () => ({ available: true, reason: null })) });
    const orchestrator = makeOrchestrator({ store, git, runner, github, autoOpenPr: false });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "suite green"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(github.checkAvailability).not.toHaveBeenCalled();
    expect(github.createPr).not.toHaveBeenCalled();
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
  });
});

describe("RunOrchestrator.runCard — finalize: PR-open resilience (retry + REST fallback on transient GitHub failures)", () => {
  // Motivated by a live incident: reviewer PASSed T-0117, `gh pr create` (GraphQL) failed with
  // "HTTP 503 ... api.github.com/graphql", the failure was swallowed, and the card sat in
  // `review` with `pr: null` until a human noticed. REST stayed up throughout.
  async function driveToPass(runner) {
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "suite green"))));
    reviewChild.emit("exit", 0, null);
  }

  it("retries gh pr create through transient 503s and succeeds within the retry budget, recording the PR", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const createPr = vi
      .fn()
      .mockRejectedValueOnce(ghErr("HTTP 503: Service Unavailable (api.github.com/graphql)", "transient"))
      .mockRejectedValueOnce(ghErr("HTTP 503: Service Unavailable (api.github.com/graphql)", "transient"))
      .mockResolvedValueOnce("https://github.com/example/repo/pull/501");
    const sleepFn = vi.fn(async () => {});
    const github = makeGithub({ checkAvailability: vi.fn(async () => ({ available: true, reason: null })), createPr });
    const orchestrator = makeOrchestrator({ store, git, runner, github, sleepFn });

    const runPromise = orchestrator.runCard("T-0001");
    await driveToPass(runner);
    await runPromise;

    expect(createPr).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    // Exponential backoff from the named base constant, doubling each retry.
    expect(sleepFn.mock.calls[0][0]).toBe(PR_OPEN_BACKOFF_BASE_MS);
    expect(sleepFn.mock.calls[1][0]).toBe(PR_OPEN_BACKOFF_BASE_MS * 2);

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
    expect(finalTask.pr).toBe("https://github.com/example/repo/pull/501");
  });

  it("falls back to the REST API once gh pr create exhausts its retry budget on persistent 503s, recording the REST PR", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const createPr = vi.fn(async () => {
      throw ghErr("HTTP 503: Service Unavailable (api.github.com/graphql)", "transient");
    });
    const createPrRest = vi.fn(async () => "https://github.com/example/repo/pull/601");
    const github = makeGithub({
      checkAvailability: vi.fn(async () => ({ available: true, reason: null })),
      createPr,
      createPrRest
    });
    const orchestrator = makeOrchestrator({ store, git, runner, github, sleepFn: vi.fn(async () => {}) });

    const runPromise = orchestrator.runCard("T-0001");
    await driveToPass(runner);
    await runPromise;

    expect(createPr).toHaveBeenCalledTimes(PR_OPEN_GRAPHQL_MAX_ATTEMPTS);
    expect(createPrRest).toHaveBeenCalledTimes(1);
    const restCall = createPrRest.mock.calls[0][0];
    expect(restCall.base).toBe("develop");
    expect(restCall.head).toBe("feature/T-0001");

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
    expect(finalTask.pr).toBe("https://github.com/example/repo/pull/601");
  });

  it("treats 'pull request already exists' from gh pr create as success and captures the existing PR instead of erroring or duplicating", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const createPr = vi.fn(async () => {
      throw ghErr("GraphQL: A pull request already exists for me:feature/T-0001. (createPullRequest)", "already-exists");
    });
    const findExistingPr = vi
      .fn()
      .mockResolvedValueOnce(null) // pre-create idempotency check: nothing yet
      .mockResolvedValueOnce("https://github.com/example/repo/pull/701"); // post-failure lookup finds it
    const github = makeGithub({
      checkAvailability: vi.fn(async () => ({ available: true, reason: null })),
      createPr,
      findExistingPr
    });
    const orchestrator = makeOrchestrator({ store, git, runner, github, sleepFn: vi.fn(async () => {}) });

    const runPromise = orchestrator.runCard("T-0001");
    await driveToPass(runner);
    await runPromise;

    expect(createPr).toHaveBeenCalledTimes(1);
    expect(findExistingPr).toHaveBeenCalledTimes(2);
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
    expect(finalTask.pr).toBe("https://github.com/example/repo/pull/701");
  });

  it("does not retry or fall back to REST on a terminal (non-transient) failure -- but still leaves an explanatory comment, not a silent failure", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const createPr = vi.fn(async () => {
      throw ghErr("HTTP 401: Bad credentials", "terminal");
    });
    const createPrRest = vi.fn(async () => "https://github.com/example/repo/pull/999");
    const github = makeGithub({
      checkAvailability: vi.fn(async () => ({ available: true, reason: null })),
      createPr,
      createPrRest
    });
    const orchestrator = makeOrchestrator({ store, git, runner, github, sleepFn: vi.fn(async () => {}) });

    const runPromise = orchestrator.runCard("T-0001");
    await driveToPass(runner);
    await runPromise;

    expect(createPr).toHaveBeenCalledTimes(1);
    expect(createPrRest).not.toHaveBeenCalled();

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
    expect(finalTask.pr).toBeFalsy();
    expect(finalTask.comments?.some((c) => /PR-open failed/i.test(c.text))).toBe(true);
  });

  it("when GraphQL retries AND the REST fallback both fail, leaves the card retryable (review, no pr) with a clear comment instead of a silent dead end", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const createPr = vi.fn(async () => {
      throw ghErr("HTTP 503: Service Unavailable (api.github.com/graphql)", "transient");
    });
    const createPrRest = vi.fn(async () => {
      throw ghErr("HTTP 503: Service Unavailable", "transient");
    });
    const github = makeGithub({
      checkAvailability: vi.fn(async () => ({ available: true, reason: null })),
      createPr,
      createPrRest
    });
    const orchestrator = makeOrchestrator({ store, git, runner, github, sleepFn: vi.fn(async () => {}) });

    const runPromise = orchestrator.runCard("T-0001");
    await driveToPass(runner);
    await runPromise;

    expect(createPr).toHaveBeenCalledTimes(PR_OPEN_GRAPHQL_MAX_ATTEMPTS);
    expect(createPrRest).toHaveBeenCalledTimes(PR_OPEN_REST_MAX_ATTEMPTS);

    const finalTask = await store.get("T-0001");
    // Still retryable: "review" is one of runCard()'s accepted starting statuses, so a later
    // re-run (human click or automation) will retry PR-open -- never silently stuck.
    expect(finalTask.status).toBe("review");
    expect(finalTask.pr).toBeFalsy();
    expect(finalTask.comments).toBeTruthy();
    const lastComment = finalTask.comments[finalTask.comments.length - 1];
    expect(lastComment.text).toMatch(/PR-open failed/i);
    expect(lastComment.text).toMatch(/retries/i);
    expect(lastComment.text).toContain(finalTask.branch);
    expect(lastComment.text).toContain(finalTask.commit);
  });
});

describe("RunOrchestrator.runCard — finalize: merge origin/develop into the branch after a PR exists", () => {
  function makeGithubWithPr(overrides = {}) {
    return makeGithub({
      checkAvailability: vi.fn(async () => ({ available: true, reason: null })),
      createPr: vi.fn(async () => "https://github.com/example/repo/pull/9"),
      ...overrides
    });
  }

  async function driveToPass(runner) {
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "suite green"))));
    reviewChild.emit("exit", 0, null);
  }

  it("fetches and merges origin/develop into the branch once a PR exists, and pushes again when the merge produced new commits", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit({ mergeDevelop: vi.fn(async () => ({ conflicted: false, changed: true })) });
    const runner = makeRunner();
    const github = makeGithubWithPr();
    const orchestrator = makeOrchestrator({ store, git, runner, github });

    const runPromise = orchestrator.runCard("T-0001");
    await driveToPass(runner);
    await runPromise;

    expect(git.fetch).toHaveBeenCalledWith({ worktreeDir: "/repo/worktrees/T-0001" });
    expect(git.mergeDevelop).toHaveBeenCalledWith({ worktreeDir: "/repo/worktrees/T-0001", baseBranch: "develop" });
    expect(git.push).toHaveBeenCalledTimes(2);
    expect(git.push).toHaveBeenNthCalledWith(2, { worktreeDir: "/repo/worktrees/T-0001", branch: "feature/T-0001" });
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
  });

  it("does not push again when the branch already contained everything on origin/develop (no-op merge)", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit({ mergeDevelop: vi.fn(async () => ({ conflicted: false, changed: false })) });
    const runner = makeRunner();
    const github = makeGithubWithPr();
    const orchestrator = makeOrchestrator({ store, git, runner, github });

    const runPromise = orchestrator.runCard("T-0001");
    await driveToPass(runner);
    await runPromise;

    expect(git.push).toHaveBeenCalledTimes(1);
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
  });

  it("skips the develop-sync step entirely when no PR was opened (gh unavailable)", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const github = makeGithub({ checkAvailability: vi.fn(async () => ({ available: false, reason: "not-installed" })) });
    const orchestrator = makeOrchestrator({ store, git, runner, github });

    const runPromise = orchestrator.runCard("T-0001");
    await driveToPass(runner);
    await runPromise;

    expect(git.fetch).not.toHaveBeenCalled();
    expect(git.mergeDevelop).not.toHaveBeenCalled();
  });

  it("on conflict, hands off to the owning agent (a third run phase) with the conflicted files and hunks instead of resolving mechanically", async () => {
    const store = makeStore([baseTask({ agent: "server" })]);
    const conflictResult = {
      conflicted: true,
      conflictedFiles: ["server/src/handler.cpp"],
      hunks: { "server/src/handler.cpp": "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/develop\n" }
    };
    const git = makeGit({
      mergeDevelop: vi.fn(async () => conflictResult),
      mergeStatus: vi.fn(async () => []),
      hasUncommittedChanges: vi.fn(async () => false)
    });
    const runner = makeRunner();
    const github = makeGithubWithPr();
    const buildMergeConflictPromptFn = vi.fn(() => "resolve these conflicts");
    const orchestrator = makeOrchestrator({ store, git, runner, github, buildMergeConflictPromptFn });

    const runPromise = orchestrator.runCard("T-0001");
    await driveToPass(runner);

    const conflictChild = await nthChild(runner, 3);
    expect(runner.start).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ prompt: "resolve these conflicts", worktreeDir: "/repo/worktrees/T-0001" })
    );
    expect(buildMergeConflictPromptFn).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: "develop",
        branch: "feature/T-0001",
        conflictedFiles: conflictResult.conflictedFiles,
        hunks: conflictResult.hunks
      })
    );
    conflictChild.emit("exit", 0, null);
    await runPromise;

    expect(git.push).toHaveBeenCalledTimes(2);
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
  });

  it("never resolves conflicts mechanically -- does not push and blocks the card (with the PR link preserved) when the agent leaves conflicts unresolved", async () => {
    const store = makeStore([baseTask()]);
    const conflictResult = {
      conflicted: true,
      conflictedFiles: ["tools/board/src/thing.js"],
      hunks: { "tools/board/src/thing.js": "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/develop\n" }
    };
    const git = makeGit({
      mergeDevelop: vi.fn(async () => conflictResult),
      // Agent's phase exits 0 but never actually finished resolving -- still unmerged.
      mergeStatus: vi.fn(async () => ["tools/board/src/thing.js"])
    });
    const runner = makeRunner();
    const github = makeGithubWithPr();
    const orchestrator = makeOrchestrator({ store, git, runner, github });

    const runPromise = orchestrator.runCard("T-0001");
    await driveToPass(runner);
    const conflictChild = await nthChild(runner, 3);
    conflictChild.emit("exit", 0, null);
    await runPromise;

    expect(git.push).toHaveBeenCalledTimes(1);
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.pr).toBe("https://github.com/example/repo/pull/9");
    expect(finalTask.comments.some((c) => /unresolved|not.*resolved|conflict/i.test(c.text))).toBe(true);
  });

  it("blocks the card (PR link preserved) rather than pushing when the conflict-resolution agent crashes", async () => {
    const store = makeStore([baseTask()]);
    const conflictResult = {
      conflicted: true,
      conflictedFiles: ["tools/board/src/thing.js"],
      hunks: { "tools/board/src/thing.js": "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/develop\n" }
    };
    const git = makeGit({ mergeDevelop: vi.fn(async () => conflictResult) });
    const runner = makeRunner();
    const github = makeGithubWithPr();
    const orchestrator = makeOrchestrator({ store, git, runner, github });

    const runPromise = orchestrator.runCard("T-0001");
    await driveToPass(runner);
    const conflictChild = await nthChild(runner, 3);
    conflictChild.emit("exit", 1, null);
    await runPromise;

    expect(git.push).toHaveBeenCalledTimes(1);
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.pr).toBe("https://github.com/example/repo/pull/9");
  });

  it("uses the card's own agent (not the reviewer) to resolve conflicts, loading its agent def and allowed tools", async () => {
    const store = makeStore([baseTask({ agent: "client" })]);
    const conflictResult = {
      conflicted: true,
      conflictedFiles: ["client/src/thing.gd"],
      hunks: { "client/src/thing.gd": "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/develop\n" }
    };
    const git = makeGit({ mergeDevelop: vi.fn(async () => conflictResult) });
    const runner = makeRunner();
    const github = makeGithubWithPr();
    const loadAgentDefFn = vi.fn((name) => (name === "reviewer" ? REVIEWER_DEF : { name, model: "sonnet", body: `# ${name}` }));
    const resolveAllowedToolsFn = vi.fn((name) => (name === "reviewer" ? ["Read", "Grep"] : ["Read", "Write", "Edit", "Bash(git:*)"]));
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      github,
      loadAgentDefFn,
      resolveAllowedToolsFn
    });

    const runPromise = orchestrator.runCard("T-0001");
    await driveToPass(runner);
    await nthChild(runner, 3);

    expect(loadAgentDefFn).toHaveBeenCalledWith("client", expect.anything());
    expect(resolveAllowedToolsFn).toHaveBeenCalledWith("client", expect.anything());
    expect(runner.start).toHaveBeenNthCalledWith(3, expect.objectContaining({ model: "sonnet" }));

    runner.spawnedChildren[2].emit("exit", 1, null);
    await runPromise;
  });

  it("never force-pushes and never auto-resolves by discarding either side -- the merge step itself must never mechanically choose ours/theirs", async () => {
    const store = makeStore([baseTask()]);
    const conflictResult = {
      conflicted: true,
      conflictedFiles: ["tools/board/src/thing.js"],
      hunks: { "tools/board/src/thing.js": "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/develop\n" }
    };
    const git = makeGit({ mergeDevelop: vi.fn(async () => conflictResult) });
    const runner = makeRunner();
    const github = makeGithubWithPr();
    const orchestrator = makeOrchestrator({ store, git, runner, github });

    const runPromise = orchestrator.runCard("T-0001");
    await driveToPass(runner);
    const conflictChild = await nthChild(runner, 3);
    conflictChild.emit("exit", 0, null);
    await runPromise;

    for (const call of git.push.mock.calls) {
      expect(call[0].force).not.toBe(true);
    }
  });
});

describe("RunOrchestrator.runCard — auto-capture uncommitted implementer work before review (safety net)", () => {
  it("commits leftover uncommitted/untracked changes from the implementer phase before the reviewer runs", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);

    // The reviewer phase must not start until the capture commit has been attempted.
    await nthChild(runner, 2);

    expect(git.commitAll).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeDir: "/repo/worktrees/T-0001",
        message: expect.stringContaining("chore(T-0001): capture uncommitted implementer changes"),
        author: expect.objectContaining({ name: "assembled-board", email: "board@localhost" })
      })
    );

    const reviewChild = runner.spawnedChildren[1];
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "ok"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;
  });

  it("captures before computing the reviewer's diff, so the reviewer sees the captured commit", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const callOrder = [];
    git.commitAll.mockImplementation(async (args) => {
      callOrder.push("commitAll");
      return args.message.includes("capture") ? true : true;
    });
    git.diffNames.mockImplementation(async () => {
      callOrder.push("diffNames");
      return ["tools/board/src/thing.js"];
    });
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "ok"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(callOrder[0]).toBe("commitAll");
    expect(callOrder).toContain("diffNames");
    expect(callOrder.indexOf("commitAll")).toBeLessThan(callOrder.indexOf("diffNames"));
  });

  it("does not create an empty commit when the worktree is already clean after the implementer phase (no-op guard)", async () => {
    const store = makeStore([baseTask()]);
    // commitAll mirrors the real gitOps behavior: false when there's nothing to commit.
    const git = makeGit({ commitAll: vi.fn(async () => false) });
    const runner = makeRunner();
    const hub = { broadcast: vi.fn() };
    const orchestrator = makeOrchestrator({ store, git, runner, hub });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "ok"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    const captureMessages = hub.broadcast.mock.calls
      .map(([m]) => m)
      .filter((m) => m.type === "run-event" && m.phase === "capture");
    expect(captureMessages).toHaveLength(0);
  });

  it("logs and broadcasts when it captures leftover work", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit({ commitAll: vi.fn(async () => true) });
    const runner = makeRunner();
    const hub = { broadcast: vi.fn() };
    const orchestrator = makeOrchestrator({ store, git, runner, hub });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "ok"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    const captureMessages = hub.broadcast.mock.calls
      .map(([m]) => m)
      .filter((m) => m.type === "run-event" && m.phase === "capture");
    expect(captureMessages.length).toBeGreaterThanOrEqual(1);
    expect(captureMessages[0].id).toBe("T-0001");
    expect(captureMessages[0].event.message).toMatch(/captured uncommitted implementer changes/i);
  });

  it("does not run the capture step when a card fails the implementer phase (never reaches review)", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 1, null);
    await runPromise;

    expect(git.commitAll).not.toHaveBeenCalled();
  });

  it("respects autoCaptureUncommitted: false (config flag) by skipping the capture step entirely", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner, autoCaptureUncommitted: false });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "ok"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    // commitAll is still called once from _handlePass's own final commit -- but never with
    // the capture-specific message, since the capture step itself was skipped.
    const captureCalls = git.commitAll.mock.calls.filter(([args]) =>
      args.message.includes("capture uncommitted implementer changes")
    );
    expect(captureCalls).toHaveLength(0);
  });
});

describe("RunOrchestrator.cancelRun", () => {
  it("throws when there is no active run for the card", async () => {
    const store = makeStore([baseTask()]);
    const orchestrator = makeOrchestrator({ store, git: makeGit(), runner: makeRunner() });
    await expect(orchestrator.cancelRun("T-0001")).rejects.toThrow(/no active run/i);
  });

  it("kills the running process, removes the worktree, and blocks the card with a cancellation reason", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await nthChild(runner, 1);

    await orchestrator.cancelRun("T-0001");

    expect(runner.kill).toHaveBeenCalledTimes(1);
    expect(git.removeWorktree).toHaveBeenCalledWith({ repoRoot: "/repo", worktreeDir: "/repo/worktrees/T-0001" });

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.body).toMatch(/cancel/i);

    await runPromise;
    expect(orchestrator.isRunning("T-0001")).toBe(false);
  });

  it("leaves the card cancel-blocked even though runCard's own loop would otherwise have continued to the reviewer", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await nthChild(runner, 1);
    await orchestrator.cancelRun("T-0001");
    await runPromise;

    expect(runner.start).toHaveBeenCalledTimes(1);
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
  });
});

describe("RunOrchestrator.runCard — unassigned cards (agent: null) route through planner then generic agent", () => {
  const PLANNER_DEF = { name: "planner", model: "opus", body: "# planner\nAudits and expands the backlog." };
  const GENERIC_DEF = { name: "generic", model: "sonnet", body: "# generic\nGeneral-purpose implementer." };

  function makeUnassignedTask(overrides = {}) {
    return baseTask({ agent: null, ...overrides });
  }

  function makeAgentDefFn() {
    return vi.fn((name) => {
      if (name === "reviewer") return REVIEWER_DEF;
      if (name === "planner") return PLANNER_DEF;
      if (name === "generic") return GENERIC_DEF;
      return IMPLEMENTER_DEF;
    });
  }

  it("broadcasts visible feedback before any agent runs — never silently no-ops for unassigned cards", async () => {
    const store = makeStore([makeUnassignedTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const hub = { broadcast: vi.fn() };
    const orchestrator = makeOrchestrator({
      store, git, runner, hub,
      loadAgentDefFn: makeAgentDefFn()
    });

    const runPromise = orchestrator.runCard("T-0001");

    // Feedback must arrive before (or as soon as) the planning phase runner starts
    const plannerChild = await nthChild(runner, 1);

    const broadcasts = hub.broadcast.mock.calls.map(([msg]) => msg);
    const planningBroadcast = broadcasts.find((m) => m.phase === "planning");
    expect(planningBroadcast).toBeDefined();
    expect(planningBroadcast.id).toBe("T-0001");

    // clean up
    plannerChild.emit("exit", 1, null);
    await runPromise;
  });

  it("runs planner first, then generic implementer, then reviewer — three phases total", async () => {
    const store = makeStore([makeUnassignedTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({
      store, git, runner,
      loadAgentDefFn: makeAgentDefFn()
    });

    const runPromise = orchestrator.runCard("T-0001");

    // Phase 1: planner
    const plannerChild = await nthChild(runner, 1);
    plannerChild.emit("exit", 0, null);

    // Phase 2: generic implementer
    const implChild = await nthChild(runner, 2);
    implChild.emit("exit", 0, null);

    // Phase 3: reviewer
    const reviewChild = await nthChild(runner, 3);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`Done. ${verdictBlock("PASS", "looks good")}`)));
    reviewChild.emit("exit", 0, null);

    await runPromise;

    expect(runner.start).toHaveBeenCalledTimes(3);
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
  });

  it("uses the planner agent def and model for the planning phase", async () => {
    const store = makeStore([makeUnassignedTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const loadAgentDefFn = makeAgentDefFn();
    const orchestrator = makeOrchestrator({
      store, git, runner,
      loadAgentDefFn
    });

    const runPromise = orchestrator.runCard("T-0001");

    const plannerChild = await nthChild(runner, 1);
    // planner agent model must be used for the first runner.start call
    expect(runner.start).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: PLANNER_DEF.model })
    );
    expect(loadAgentDefFn).toHaveBeenCalledWith("planner", expect.anything());

    plannerChild.emit("exit", 1, null);
    await runPromise;
  });

  it("uses the generic agent def and model for the implementation phase", async () => {
    const store = makeStore([makeUnassignedTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const loadAgentDefFn = makeAgentDefFn();
    const orchestrator = makeOrchestrator({
      store, git, runner,
      loadAgentDefFn
    });

    const runPromise = orchestrator.runCard("T-0001");

    const plannerChild = await nthChild(runner, 1);
    plannerChild.emit("exit", 0, null);

    const implChild = await nthChild(runner, 2);
    expect(runner.start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model: GENERIC_DEF.model })
    );
    expect(loadAgentDefFn).toHaveBeenCalledWith("generic", expect.anything());

    implChild.emit("exit", 1, null);
    await runPromise;
  });

  it("blocks the card if the planner phase exits with a non-zero code; generic agent never starts", async () => {
    const store = makeStore([makeUnassignedTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({
      store, git, runner,
      loadAgentDefFn: makeAgentDefFn()
    });

    const runPromise = orchestrator.runCard("T-0001");

    const plannerChild = await nthChild(runner, 1);
    plannerChild.emit("exit", 1, null);

    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.body).toMatch(/planner/i);
    // only the planner ran — generic and reviewer were not started
    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  it("blocks the card if the generic implementer phase fails; reviewer never starts", async () => {
    const store = makeStore([makeUnassignedTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({
      store, git, runner,
      loadAgentDefFn: makeAgentDefFn()
    });

    const runPromise = orchestrator.runCard("T-0001");

    const plannerChild = await nthChild(runner, 1);
    plannerChild.emit("exit", 0, null);

    const implChild = await nthChild(runner, 2);
    implChild.emit("exit", 1, null);

    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(runner.start).toHaveBeenCalledTimes(2);
  });

  it("uses buildPlannerPromptFn for the planning phase, not the standard buildPromptFn", async () => {
    const store = makeStore([makeUnassignedTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const buildPromptFn = vi.fn(() => "implementer prompt");
    const buildPlannerPromptFn = vi.fn(() => "planner prompt");
    const orchestrator = makeOrchestrator({
      store, git, runner,
      loadAgentDefFn: makeAgentDefFn(),
      buildPromptFn,
      buildPlannerPromptFn
    });

    const runPromise = orchestrator.runCard("T-0001");

    const plannerChild = await nthChild(runner, 1);
    // planner prompt builder must have been called, not the standard one
    expect(buildPlannerPromptFn).toHaveBeenCalledOnce();
    expect(buildPlannerPromptFn).toHaveBeenCalledWith(
      expect.objectContaining({ task: expect.objectContaining({ id: "T-0001" }) })
    );

    plannerChild.emit("exit", 1, null);
    await runPromise;

    // standard buildPromptFn must NOT have been called for the planning phase
    // (it may be called for the generic implementer phase, which did not run here)
    expect(buildPromptFn).not.toHaveBeenCalled();
  });

  it("passes the card's comments to buildPlannerPromptFn so a comment on an unassigned card reaches the planner", async () => {
    const comments = [{ author: "Dennie", text: "This card also needs a CLI flag.", timestamp: "2026-08-05T12:00:00.000Z" }];
    const store = makeStore([makeUnassignedTask({ comments })]);
    const git = makeGit();
    const runner = makeRunner();
    const buildPlannerPromptFn = vi.fn(() => "planner prompt");
    const orchestrator = makeOrchestrator({
      store, git, runner,
      loadAgentDefFn: makeAgentDefFn(),
      buildPlannerPromptFn
    });

    const runPromise = orchestrator.runCard("T-0001");

    const plannerChild = await nthChild(runner, 1);
    expect(buildPlannerPromptFn).toHaveBeenCalledWith(expect.objectContaining({ comments }));

    plannerChild.emit("exit", 1, null);
    await runPromise;
  });

  it("passes an empty comments array to buildPlannerPromptFn when the card has none", async () => {
    const store = makeStore([makeUnassignedTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const buildPlannerPromptFn = vi.fn(() => "planner prompt");
    const orchestrator = makeOrchestrator({
      store, git, runner,
      loadAgentDefFn: makeAgentDefFn(),
      buildPlannerPromptFn
    });

    const runPromise = orchestrator.runCard("T-0001");

    const plannerChild = await nthChild(runner, 1);
    expect(buildPlannerPromptFn).toHaveBeenCalledWith(expect.objectContaining({ comments: [] }));

    plannerChild.emit("exit", 1, null);
    await runPromise;
  });

  it("broadcasts run-event with phase='planning' for events from the planner", async () => {
    const store = makeStore([makeUnassignedTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const hub = { broadcast: vi.fn() };
    const orchestrator = makeOrchestrator({
      store, git, runner, hub,
      loadAgentDefFn: makeAgentDefFn()
    });

    const runPromise = orchestrator.runCard("T-0001");

    const plannerChild = await nthChild(runner, 1);
    plannerChild.stdout.emit("data", ndjson(assistantEvent("expanding spec...")));
    plannerChild.emit("exit", 0, null);

    const implChild = await nthChild(runner, 2);
    implChild.emit("exit", 1, null);
    await runPromise;

    const runEvents = hub.broadcast.mock.calls.map(([m]) => m).filter((m) => m.type === "run-event");
    const planningRunEvents = runEvents.filter((m) => m.phase === "planning");
    expect(planningRunEvents.length).toBeGreaterThan(0);
    expect(planningRunEvents.every((m) => m.id === "T-0001")).toBe(true);
  });

  it("full PASS lifecycle for an unassigned card: planning → implementer → validation → review", async () => {
    const store = makeStore([makeUnassignedTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({
      store, git, runner,
      loadAgentDefFn: makeAgentDefFn()
    });

    const runPromise = orchestrator.runCard("T-0001");

    const plannerChild = await nthChild(runner, 1);
    expect((await store.get("T-0001")).status).toBe("in-progress");
    plannerChild.emit("exit", 0, null);

    const implChild = await nthChild(runner, 2);
    implChild.emit("exit", 0, null);

    const reviewChild = await nthChild(runner, 3);
    expect((await store.get("T-0001")).status).toBe("validation");
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`All done. ${verdictBlock("PASS", "generic agent delivered")}`)));
    reviewChild.emit("exit", 0, null);

    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
    expect(finalTask.body).toContain("generic agent delivered");
    expect(git.push).toHaveBeenCalled();
  });
});

describe("RunOrchestrator.runCard — a card explicitly assigned agent: 'generic' runs directly, no planner phase", () => {
  const GENERIC_DEF = { name: "generic", model: "sonnet", body: "# generic\nGeneral-purpose implementer." };

  function makeAgentDefFn() {
    return vi.fn((name) => (name === "reviewer" ? REVIEWER_DEF : GENERIC_DEF));
  }

  it("runs the generic implementer directly then the reviewer -- two phases total, no planning phase", async () => {
    const store = makeStore([baseTask({ agent: "generic" })]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({
      store, git, runner,
      loadAgentDefFn: makeAgentDefFn()
    });

    const runPromise = orchestrator.runCard("T-0001");

    const implChild = await nthChild(runner, 1);
    expect((await store.get("T-0001")).status).toBe("in-progress");
    implChild.emit("exit", 0, null);

    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`Done. ${verdictBlock("PASS", "generic ran directly")}`)));
    reviewChild.emit("exit", 0, null);

    await runPromise;

    expect(runner.start).toHaveBeenCalledTimes(2);
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
    expect(finalTask.body).toContain("generic ran directly");
  });

  it("uses the generic agent def and model for the (only) implementation phase, loaded the same way a subsystem agent would be", async () => {
    const store = makeStore([baseTask({ agent: "generic" })]);
    const git = makeGit();
    const runner = makeRunner();
    const loadAgentDefFn = makeAgentDefFn();
    const orchestrator = makeOrchestrator({
      store, git, runner,
      loadAgentDefFn
    });

    const runPromise = orchestrator.runCard("T-0001");

    const implChild = await nthChild(runner, 1);
    expect(runner.start).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: GENERIC_DEF.model })
    );
    expect(loadAgentDefFn).toHaveBeenCalledWith("generic", expect.anything());

    implChild.emit("exit", 1, null);
    await runPromise;
  });

  it("uses buildPromptFn (the standard implementer prompt), not buildPlannerPromptFn", async () => {
    const store = makeStore([baseTask({ agent: "generic" })]);
    const git = makeGit();
    const runner = makeRunner();
    const buildPromptFn = vi.fn(() => "implementer prompt");
    const buildPlannerPromptFn = vi.fn(() => "planner prompt");
    const orchestrator = makeOrchestrator({
      store, git, runner,
      loadAgentDefFn: makeAgentDefFn(),
      buildPromptFn,
      buildPlannerPromptFn
    });

    const runPromise = orchestrator.runCard("T-0001");
    await nthChild(runner, 1);

    expect(buildPromptFn).toHaveBeenCalledWith(
      expect.objectContaining({ task: expect.objectContaining({ id: "T-0001", agent: "generic" }) })
    );
    expect(buildPlannerPromptFn).not.toHaveBeenCalled();

    const implChild = runner.spawnedChildren[0];
    implChild.emit("exit", 1, null);
    await runPromise;
  });
});

describe("RunOrchestrator — broadcasts an authoritative status change immediately (board must not depend solely on the file watcher)", () => {
  it("broadcasts a 'changed' event the moment the card moves ready -> in-progress", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const hub = { broadcast: vi.fn() };
    const orchestrator = makeOrchestrator({ store, git, runner, hub });

    const runPromise = orchestrator.runCard("T-0001");

    const implChild = await nthChild(runner, 1);

    const changedBroadcasts = hub.broadcast.mock.calls.map(([m]) => m).filter((m) => m.type === "changed");
    expect(changedBroadcasts).toContainEqual({
      type: "changed",
      id: "T-0001",
      task: expect.objectContaining({ id: "T-0001", status: "in-progress" })
    });

    implChild.emit("exit", 1, null);
    await runPromise;
  });

  it("broadcasts a 'changed' event when worktree creation fails and the card is blocked", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit({ addWorktree: vi.fn(async () => { throw new Error("disk full"); }) });
    const runner = makeRunner();
    const hub = { broadcast: vi.fn() };
    const orchestrator = makeOrchestrator({ store, git, runner, hub });

    await orchestrator.runCard("T-0001");

    const changedBroadcasts = hub.broadcast.mock.calls.map(([m]) => m).filter((m) => m.type === "changed");
    expect(changedBroadcasts).toContainEqual({
      type: "changed",
      id: "T-0001",
      task: expect.objectContaining({ id: "T-0001", status: "blocked" })
    });
  });

  it("broadcasts a 'changed' event the moment the card moves in-progress -> validation", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const hub = { broadcast: vi.fn() };
    const orchestrator = makeOrchestrator({ store, git, runner, hub });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);

    const reviewChild = await nthChild(runner, 2);

    const changedBroadcasts = hub.broadcast.mock.calls.map(([m]) => m).filter((m) => m.type === "changed");
    expect(changedBroadcasts).toContainEqual({
      type: "changed",
      id: "T-0001",
      task: expect.objectContaining({ id: "T-0001", status: "validation" })
    });

    reviewChild.emit("exit", 1, null);
    await runPromise;
  });

  it("broadcasts a 'changed' event when the reviewer PASSes and the card reaches review", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const hub = { broadcast: vi.fn() };
    const orchestrator = makeOrchestrator({ store, git, runner, hub });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);

    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`ok ${verdictBlock("PASS", "all green")}`)));
    reviewChild.emit("exit", 0, null);

    await runPromise;

    const changedBroadcasts = hub.broadcast.mock.calls.map(([m]) => m).filter((m) => m.type === "changed");
    expect(changedBroadcasts).toContainEqual({
      type: "changed",
      id: "T-0001",
      task: expect.objectContaining({ id: "T-0001", status: "review" })
    });
  });

  it("broadcasts a 'changed' event when a run is cancelled and the card is blocked", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const hub = { broadcast: vi.fn() };
    const orchestrator = makeOrchestrator({ store, git, runner, hub });

    const runPromise = orchestrator.runCard("T-0001");
    await nthChild(runner, 1);

    await orchestrator.cancelRun("T-0001");
    await runPromise;

    const changedBroadcasts = hub.broadcast.mock.calls.map(([m]) => m).filter((m) => m.type === "changed");
    expect(changedBroadcasts).toContainEqual({
      type: "changed",
      id: "T-0001",
      task: expect.objectContaining({ id: "T-0001", status: "blocked" })
    });
  });
});

describe("RunOrchestrator.hasActiveRuns / onIdle -- restart-safety window", () => {
  it("is false before a run starts, true once runCard begins, and false again only after runCard fully resolves", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const onIdle = vi.fn();
    const orchestrator = makeOrchestrator({ store, git, runner, onIdle });

    expect(orchestrator.hasActiveRuns()).toBe(false);

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    expect(orchestrator.hasActiveRuns()).toBe(true);
    expect(onIdle).not.toHaveBeenCalled();

    implChild.emit("exit", 0, null);

    // Between the implementer exiting and the reviewer child being spawned, the
    // phase-level activeRuns map is briefly empty -- but the card run is still
    // in flight, so hasActiveRuns() (the restart-safety signal) must stay true.
    const reviewChild = await nthChild(runner, 2);
    expect(orchestrator.hasActiveRuns()).toBe(true);
    expect(onIdle).not.toHaveBeenCalled();

    reviewChild.stdout.emit("data", ndjson(assistantEvent(`ok ${verdictBlock("PASS", "all green")}`)));
    reviewChild.emit("exit", 0, null);

    await runPromise;

    expect(orchestrator.hasActiveRuns()).toBe(false);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("calls onIdle after a cancelled run finishes cleaning up", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const onIdle = vi.fn();
    const orchestrator = makeOrchestrator({ store, git, runner, onIdle });

    const runPromise = orchestrator.runCard("T-0001");
    await nthChild(runner, 1);
    expect(orchestrator.hasActiveRuns()).toBe(true);

    await orchestrator.cancelRun("T-0001");
    await runPromise;

    expect(orchestrator.hasActiveRuns()).toBe(false);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("calls onIdle even when the run is blocked by a worktree creation failure", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit({ addWorktree: vi.fn(async () => { throw new Error("disk full"); }) });
    const runner = makeRunner();
    const onIdle = vi.fn();
    const orchestrator = makeOrchestrator({ store, git, runner, onIdle });

    await orchestrator.runCard("T-0001");

    expect(orchestrator.hasActiveRuns()).toBe(false);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect((await store.get("T-0001")).status).toBe("blocked");
  });

  it("keeps hasActiveRuns() true for one card while a second card is still running (no premature idle)", async () => {
    const store = makeStore([baseTask({ id: "T-0001" }), baseTask({ id: "T-0002" })]);
    const git = makeGit();
    const runner = makeRunner();
    const onIdle = vi.fn();
    const orchestrator = makeOrchestrator({ store, git, runner, onIdle });

    const run1 = orchestrator.runCard("T-0001");
    const child1Impl = await nthChild(runner, 1);
    const run2 = orchestrator.runCard("T-0002");
    const child2Impl = await nthChild(runner, 2);

    child1Impl.emit("exit", 0, null);
    const child1Review = await nthChild(runner, 3);
    child1Review.stdout.emit("data", ndjson(assistantEvent(`ok ${verdictBlock("PASS", "green")}`)));
    child1Review.emit("exit", 0, null);
    await run1;

    // T-0002's implementer is still running -- must not report idle yet.
    expect(orchestrator.hasActiveRuns()).toBe(true);
    expect(onIdle).not.toHaveBeenCalled();

    child2Impl.emit("exit", 0, null);
    const child2Review = await nthChild(runner, 4);
    child2Review.stdout.emit("data", ndjson(assistantEvent(`ok ${verdictBlock("PASS", "green")}`)));
    child2Review.emit("exit", 0, null);
    await run2;

    expect(orchestrator.hasActiveRuns()).toBe(false);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});

describe("RunOrchestrator — persists run liveness state for the orphan reaper", () => {
  it("records the child pid + run log path at the start of each phase, and clears it once runCard finishes", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const hub = { broadcast: vi.fn() };
    const writeRunStateFn = vi.fn(async () => {});
    const clearRunStateFn = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({ store, git, runner, hub, writeRunStateFn, clearRunStateFn });

    const runPromise = orchestrator.runCard("T-0001");

    const implChild = await nthChild(runner, 1);
    implChild.stdout.emit("data", ndjson(assistantEvent("implementing...")));
    implChild.emit("exit", 0, null);

    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`Reviewed. ${verdictBlock("PASS", "all green")}`)));
    reviewChild.emit("exit", 0, null);

    await runPromise;

    // The heartbeat (fix-plan item #3) also writes run state on a timer, so the meaningful
    // assertion is on the per-phase writes -- the ones carrying a spawned child's pid -- not on
    // the total call count.
    const phaseWrites = writeRunStateFn.mock.calls.filter(([args]) => typeof args.pid === "number");
    expect(phaseWrites).toHaveLength(2);
    expect(phaseWrites[0][0]).toEqual(
      expect.objectContaining({ runsDir: "/repo/tasks/.runs", taskId: "T-0001", pid: 4242 })
    );
    expect(phaseWrites[1][0]).toEqual(
      expect.objectContaining({ runsDir: "/repo/tasks/.runs", taskId: "T-0001", pid: 4242 })
    );
    expect(clearRunStateFn).toHaveBeenCalledTimes(1);
    expect(clearRunStateFn).toHaveBeenCalledWith(expect.objectContaining({ runsDir: "/repo/tasks/.runs", taskId: "T-0001" }));
  });

  it("clears run state even when a phase crashes and the card is blocked", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const hub = { broadcast: vi.fn() };
    const writeRunStateFn = vi.fn(async () => {});
    const clearRunStateFn = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({ store, git, runner, hub, writeRunStateFn, clearRunStateFn });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 1, null);
    await runPromise;

    // As above: only the pid-carrying writes are per-phase; the rest are heartbeat beats.
    expect(writeRunStateFn.mock.calls.filter(([args]) => typeof args.pid === "number")).toHaveLength(1);
    expect(clearRunStateFn).toHaveBeenCalledTimes(1);
    expect((await store.get("T-0001")).status).toBe("blocked");
  });
});

describe("RunOrchestrator — commits every in-run status write to repoRoot", () => {
  // Regression coverage: `_updateAndBroadcast` used to call `store.update()` without
  // committing, leaving repoRoot's working tree dirty after every in-run status flip
  // (ready -> in-progress -> validation -> review, or -> blocked on FAIL/crash). The next
  // Done-triggered `pullDevelop` would then abort with "local changes would be overwritten
  // by merge" the moment origin touched the same card file -- exactly the failure this
  // covers (see handlePatchTask's matching commitTaskFile call in httpApi.js).

  it("commits the card file after the in-progress status write, via git.commitTaskFile", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await nthChild(runner, 1);

    await vi.waitFor(() => expect(git.commitTaskFile).toHaveBeenCalled());
    expect(git.commitTaskFile).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/repo",
        filePath: "tasks/T-0001.md",
        message: expect.stringContaining("update card T-0001")
      })
    );

    const implChild = runner.spawnedChildren[0];
    implChild.stdout.emit("data", ndjson(assistantEvent("implementing...")));
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`Reviewed. ${verdictBlock("PASS", "all green")}`)));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    // Multiple distinct status transitions (in-progress, validation, review) each get their
    // own commit -- mirrors the one-commit-per-write behavior of comments/attachments.
    expect(git.commitTaskFile.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("blocks the card and appends a note when a FAIL exhausts retries, still committing that final write", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    for (let attempt = 1; attempt <= MAX_AUTO_RETRY_ATTEMPTS; attempt += 1) {
      const implChild = await nthChild(runner, attempt * 2 - 1);
      implChild.emit("exit", 0, null);
      const reviewChild = await nthChild(runner, attempt * 2);
      // Distinct notes per attempt -- this test exercises the commit-on-every-status-write
      // behavior through to cap exhaustion, not the §23-a no-progress abort.
      reviewChild.stdout.emit("data", ndjson(assistantEvent(`Reviewed. ${verdictBlock("FAIL", `nope (round ${attempt})`)}`)));
      reviewChild.emit("exit", 0, null);
    }
    await runPromise;

    expect((await store.get("T-0001")).status).toBe("blocked");
    expect(git.commitTaskFile).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: "/repo", filePath: "tasks/T-0001.md" })
    );
  });

  it("does not skip the status write or crash the run when git.commitTaskFile rejects", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit({ commitTaskFile: vi.fn(async () => { throw new Error("index.lock exists"); }) });
    const runner = makeRunner();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    expect((await store.get("T-0001")).status).toBe("in-progress");
    implChild.stdout.emit("data", ndjson(assistantEvent("implementing...")));
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`Reviewed. ${verdictBlock("PASS", "all green")}`)));
    reviewChild.emit("exit", 0, null);

    await expect(runPromise).resolves.toBeUndefined();
    expect((await store.get("T-0001")).status).toBe("review");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips committing when git.autoCommitCardsOnCreateFromEnv() reports the flag disabled", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit({ autoCommitCardsOnCreateFromEnv: vi.fn(() => false) });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(`Reviewed. ${verdictBlock("PASS", "all green")}`)));
    reviewChild.emit("exit", 0, null);
    await runPromise;

    expect(git.commitTaskFile).not.toHaveBeenCalled();
  });
});

describe("appendNote", () => {
  it("appends a heading and text to the end of a task body", () => {
    const result = appendNote("## Context\nOriginal.\n", "Validation: PASS", "all good");
    expect(result).toContain("## Context\nOriginal.");
    expect(result).toContain("## Validation: PASS");
    expect(result).toContain("all good");
  });
});


// ---------------------------------------------------------------------------
// Per-agent phase budgets, and telling an overrun apart from a hang (T-0228).
//
// T-0228 was killed twice at exactly 40 minutes while making steady progress --
// 26/26 ComfyUI generations succeeded, max inter-event gap 287s, nowhere near the
// 8-minute inactivity threshold. Arm A's stack measures ~240s per generation and
// the card mandates up to 8 attempts, so it could not fit a 40-minute bound. The
// kill message said "likely a hung subprocess", which is what made the diagnosis
// take two runs instead of one.
// ---------------------------------------------------------------------------

describe("RunOrchestrator per-agent phase budgets", () => {
  // Long enough that only the phase timer can fire in these tests -- the inactivity
  // watchdog would otherwise trip first, since the fixture children emit no stdout.
  const QUIET = 10 * 60 * 60 * 1000;

  it("holds an assets phase to the assets budget rather than the shorter default", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask({ agent: "assets" })]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      phaseTimeoutsByAgent: { assets: 5000 },
      inactivityTimeoutMs: QUIET,
      writeRunStateFn: vi.fn(async () => {}),
      clearRunStateFn: vi.fn(async () => {})
    });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.advanceTimersByTimeAsync(0);
    const implChild = runner.spawnedChildren[0];

    // Well past the 40-minute default, still inside the assets budget: alive.
    await vi.advanceTimersByTimeAsync(4000);
    expect(runner.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await runPromise;

    expect(runner.kill).toHaveBeenCalledWith(expect.objectContaining({ child: implChild }));
    expect((await store.get("T-0001")).status).toBe("blocked");
  });

  it("still holds a non-assets phase to the default budget", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask({ agent: "server" })]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      phaseTimeoutsByAgent: { assets: 5000 },
      inactivityTimeoutMs: QUIET,
      writeRunStateFn: vi.fn(async () => {}),
      clearRunStateFn: vi.fn(async () => {})
    });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.advanceTimersByTimeAsync(0);

    // The assets budget must not leak onto another agent.
    await vi.advanceTimersByTimeAsync(5000);
    expect(runner.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEFAULT_PHASE_TIMEOUT_MS);
    await runPromise;

    expect(runner.kill).toHaveBeenCalled();
    expect((await store.get("T-0001")).status).toBe("blocked");
  });

  it("holds the reviewer phase of an assets card to the reviewer budget, not the assets one", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask({ agent: "assets" })]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      phaseTimeoutsByAgent: { assets: 60_000 },
      inactivityTimeoutMs: QUIET,
      writeRunStateFn: vi.fn(async () => {}),
      clearRunStateFn: vi.fn(async () => {})
    });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.advanceTimersByTimeAsync(0);
    runner.spawnedChildren[0].emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    const reviewChild = runner.spawnedChildren[1];

    // The reviewer runs as the `reviewer` agent, so it gets the default budget --
    // it verifies output, it does not generate it.
    await vi.advanceTimersByTimeAsync(DEFAULT_PHASE_TIMEOUT_MS);
    await runPromise;

    expect(runner.kill).toHaveBeenCalledWith(expect.objectContaining({ child: reviewChild }));
  });

  it("lets an explicit phaseTimeoutMs override win even for an assets card", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask({ agent: "assets" })]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      phaseTimeoutMs: 1000,
      phaseTimeoutsByAgent: { assets: 60 * 60 * 1000 },
      inactivityTimeoutMs: QUIET,
      writeRunStateFn: vi.fn(async () => {}),
      clearRunStateFn: vi.fn(async () => {})
    });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await runPromise;

    expect(runner.kill).toHaveBeenCalled();
    expect((await store.get("T-0001")).status).toBe("blocked");
  });
});

describe("RunOrchestrator timeout messages distinguish overrun from hang", () => {
  it("the phase-timeout message names the budget and does not claim a hang", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask({ agent: "assets" })]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      phaseTimeoutsByAgent: { assets: 120 * 60 * 1000 },
      inactivityTimeoutMs: 10 * 60 * 60 * 1000,
      writeRunStateFn: vi.fn(async () => {}),
      clearRunStateFn: vi.fn(async () => {})
    });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120 * 60 * 1000);
    await runPromise;

    const body = (await store.get("T-0001")).body;
    expect(body).toMatch(/implementer/i);
    expect(body).toContain("120");
    expect(body).toMatch(/assets/);
    // The watchdog cannot distinguish a slow run from a stuck one, so it must not
    // assert either. The inactivity watchdog and §23-a's no-progress abort are the
    // actual hang defences.
    expect(body).not.toMatch(/hung|hang/i);
  });

  it("the inactivity message still calls out silence and a likely hang", async () => {
    vi.useFakeTimers();
    const store = makeStore([baseTask({ agent: "assets" })]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      inactivityTimeoutMs: 1000,
      phaseTimeoutsByAgent: { assets: 10 * 60 * 60 * 1000 },
      writeRunStateFn: vi.fn(async () => {}),
      clearRunStateFn: vi.fn(async () => {})
    });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.runAllTimersAsync();
    await runPromise;

    const body = (await store.get("T-0001")).body;
    expect(body).toMatch(/no new output|went silent/i);
    expect(body).toMatch(/hang|hung/i);
  });
});
