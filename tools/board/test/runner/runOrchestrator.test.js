import { describe, it, expect, vi } from "vitest";
import { buildPrTitle, buildPrBody } from "../../src/runner/prBuilder.js";
import { EventEmitter } from "node:events";
import { RunOrchestrator, appendNote } from "../../src/runner/runOrchestrator.js";

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

describe("RunOrchestrator.runCard — FAIL validation", () => {
  it("sends the card back to in-progress with the reviewer's reasons, and keeps the worktree", async () => {
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

    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("in-progress");
    expect(finalTask.body).toContain("missing test at src/foo.js:12");
    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
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

  it("(d) a FAIL verdict never opens a PR", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const github = makeGithub({ checkAvailability: vi.fn(async () => ({ available: true, reason: null })) });
    const orchestrator = makeOrchestrator({ store, git, runner, github });

    const runPromise = orchestrator.runCard("T-0001");
    const implChild = await nthChild(runner, 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, 2);
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("FAIL", "missing test"))));
    reviewChild.emit("exit", 0, null);
    await runPromise;

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

describe("appendNote", () => {
  it("appends a heading and text to the end of a task body", () => {
    const result = appendNote("## Context\nOriginal.\n", "Validation: PASS", "all good");
    expect(result).toContain("## Context\nOriginal.");
    expect(result).toContain("## Validation: PASS");
    expect(result).toContain("all good");
  });
});
