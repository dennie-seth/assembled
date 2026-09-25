import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { RunOrchestrator } from "../../src/runner/runOrchestrator.js";
import { rmTemp } from "../helpers/rmTemp.js";

/**
 * T-0396: the board threads its own run id (the same id `createRunLog` derives for
 * `tasks/.runs/<id>.jsonl`) through to (a) the spawned child's `BOARD_RUN_ID` env var, via
 * `runner.start()`'s `boardRunId`, and (b) the implementer prompt's own "## Run id" section,
 * via `buildPromptFn`'s `runId` -- so a committed attempt frame can always be traced back to
 * the run log that produced it, without depending on agent discipline to record it correctly.
 */

const IMPLEMENTER_DEF = { name: "assets", model: "sonnet", body: "# assets\nProduces art." };
const REVIEWER_DEF = { name: "reviewer", model: "opus", body: "# reviewer\nRead-only VALIDATION gate." };
const RUN_ID = "T-0272-2026-09-25T00-00-00-000Z";

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
    async get(id) {
      return tasks.has(id) ? { ...tasks.get(id) } : null;
    },
    async update(id, updates) {
      const existing = tasks.get(id);
      const merged = { ...existing, ...updates, id };
      tasks.set(id, merged);
      return { ...merged };
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
    runId: RUN_ID,
    async append(event) {
      events.push(event);
    },
    close: vi.fn(async () => {})
  };
}

function baseTask(overrides = {}) {
  return {
    id: "T-0272",
    title: "Some card",
    status: "ready",
    priority: "P1",
    phase: 2,
    agent: "assets",
    depends_on: [],
    created: "2026-09-06",
    comments: [],
    requires_approval: false,
    approved_by: null,
    approved_at: null,
    body: "## Context\nDo it.\n\n## Acceptance\n- [ ] a thing exists\n",
    ...overrides
  };
}

function makeGit(overrides = {}) {
  return {
    addWorktree: vi.fn(async () => {}),
    removeWorktree: vi.fn(async () => {}),
    diffNames: vi.fn(async () => ["assets/src/concept/sheet.png"]),
    commitAll: vi.fn(async () => true),
    push: vi.fn(async () => {}),
    getHeadCommit: vi.fn(async () => "abc1234def5678abc1234def5678abc1234def5"),
    linkBoardNodeModules: vi.fn(async () => {}),
    commitTaskFile: vi.fn(async () => true),
    autoCommitCardsOnCreateFromEnv: vi.fn(() => false),
    fetch: vi.fn(async () => {}),
    mergeDevelop: vi.fn(async () => ({ conflicted: false, changed: false })),
    mergeStatus: vi.fn(async () => []),
    hasUncommittedChanges: vi.fn(async () => false),
    ...overrides
  };
}

function makeRunner() {
  const spawnedChildren = [];
  const startCalls = [];
  const start = vi.fn(async (opts) => {
    startCalls.push(opts);
    const child = fakeChildProcess();
    spawnedChildren.push(child);
    return { runId: "run", child };
  });
  return { start, kill: vi.fn((run) => run.child.kill()), spawnedChildren, startCalls };
}

function makeOrchestrator({ store, git, runner, worktreesDir, buildPromptFn }) {
  return new RunOrchestrator({
    store,
    hub: { broadcast: vi.fn() },
    runner,
    git,
    github: {
      checkAvailability: vi.fn(async () => ({ available: false, reason: "not-installed" })),
      findExistingPr: vi.fn(async () => null),
      createPr: vi.fn(async () => "https://github.com/example/repo/pull/1")
    },
    repoRoot: "/repo",
    worktreesDir,
    runsDir: "/repo/tasks/.runs",
    agentsDir: "/repo/.claude/agents",
    rulesDir: "/repo/.claude/rules",
    loadAgentDefFn: (name) => (name === "reviewer" ? REVIEWER_DEF : IMPLEMENTER_DEF),
    loadRulesFn: () => [{ name: "conduct", paths: ["**"], body: "TDD." }],
    resolveAllowedToolsFn: () => ["Read", "Write"],
    createRunLogFn: vi.fn(async () => makeRunLog()),
    buildPromptFn,
    crossCheckVerdictFn: ({ verdict }) => verdict,
    readVerdictEntriesFn: async () => [],
    appendVerdictEntryFn: async () => {}
  });
}

async function nthChild(runner, n) {
  await vi.waitFor(() => expect(runner.start).toHaveBeenCalledTimes(n));
  return runner.spawnedChildren[n - 1];
}

async function runToPass(orchestrator, runner, id) {
  const runPromise = orchestrator.runCard(id);

  const implChild = await nthChild(runner, 1);
  implChild.stdout.emit("data", ndjson(assistantEvent("working...")));
  implChild.emit("exit", 0, null);

  const reviewChild = await nthChild(runner, 2);
  reviewChild.stdout.emit("data", ndjson(assistantEvent(`Reviewed. ${verdictBlock("PASS", "looks good")}`)));
  reviewChild.emit("exit", 0, null);

  await runPromise;
}

describe("T-0396: run id threaded from createRunLog through to the child's env and prompt", () => {
  let worktreesDir;

  beforeEach(async () => {
    worktreesDir = await fs.mkdtemp(path.join(tmpdir(), "board-runid-"));
    await fs.mkdir(path.join(worktreesDir, "T-0272"), { recursive: true });
  });

  afterEach(async () => {
    await rmTemp(worktreesDir);
  });

  it("passes runLog.runId as boardRunId to every phase's runner.start() call -- implementer and reviewer alike", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner, worktreesDir, buildPromptFn: () => "PROMPT" });

    await runToPass(orchestrator, runner, "T-0272");

    expect(runner.startCalls).toHaveLength(2);
    for (const call of runner.startCalls) {
      expect(call.boardRunId).toBe(RUN_ID);
    }
  });

  it("passes runLog.runId as runId into the implementer prompt builder", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const promptCalls = [];
    const buildPromptFn = vi.fn((opts) => {
      promptCalls.push(opts);
      return "PROMPT";
    });
    const orchestrator = makeOrchestrator({ store, git, runner, worktreesDir, buildPromptFn });

    await runToPass(orchestrator, runner, "T-0272");

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0].runId).toBe(RUN_ID);
  });
});
