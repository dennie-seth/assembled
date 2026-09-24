import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { RunOrchestrator } from "../../src/runner/runOrchestrator.js";
import { ROUND_CAP } from "../../src/lib/roundCap.js";

const IMPLEMENTER_DEF = { name: "infra", model: "sonnet", body: "# infra\nImplements board tooling." };
const REVIEWER_DEF = { name: "reviewer", model: "opus", body: "# reviewer\nRead-only VALIDATION gate." };

const INFRA_ALLOWED_TOOLS = ["Read", "Write", "Edit", "Grep", "Glob", "Bash(node:*)", "Bash(npm:*)", "Bash(npx vitest:*)", "Bash(git:*)"];

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

function makeOrchestrator({ store, git, runner, hub, github, idAllocator, runLogs = [], ...overrides } = {}) {
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
    taskStoreKind: "db",
    loadAgentDefFn: (name) => (name === "reviewer" ? REVIEWER_DEF : IMPLEMENTER_DEF),
    loadRulesFn: () => [{ name: "conduct", paths: ["**"], body: "TDD." }],
    resolveAllowedToolsFn: (name) => (name === "reviewer" ? ["Read", "Grep"] : INFRA_ALLOWED_TOOLS),
    createRunLogFn,
    crossCheckVerdictFn: ({ verdict }) => verdict,
    readVerdictEntriesFn: async () => [],
    appendVerdictEntryFn: async () => {},
    ...overrides
  });
}

async function runToCompletion(orchestrator, runner, verdict = "PASS", notes = "all good") {
  const runPromise = orchestrator.runCard("T-0001");
  await vi.waitFor(() => expect(runner.start).toHaveBeenCalledTimes(1));

  const implChild = runner.spawnedChildren[0];
  implChild.emit("exit", 0, null);
  const reviewChild = await vi.waitFor(() => {
    expect(runner.start).toHaveBeenCalledTimes(2);
    return runner.spawnedChildren[1];
  });
  reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock(verdict, notes))));
  reviewChild.emit("exit", 0, null);
  await runPromise;
}

describe("RunOrchestrator -- structurally-unsatisfiable acceptance items (T-0409)", () => {
  it("passes taskStoreKind and the implementer agent through to buildReviewerPromptFn", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const buildReviewerPromptFn = vi.fn(() => "reviewer prompt");
    const orchestrator = makeOrchestrator({ store, git, runner, buildReviewerPromptFn });

    await runToCompletion(orchestrator, runner);

    expect(buildReviewerPromptFn).toHaveBeenCalledWith(
      expect.objectContaining({ implementerAgent: "infra", taskStoreKind: "db" })
    );
  });

  it("still warns (never blocks) at preflight for a .claude/** edit criterion in db mode, and the implementer runs", async () => {
    const store = makeStore([
      baseTask({
        body:
          "## Context\nUpdate docs.\n\n## Acceptance\n" +
          "- [ ] `.claude/agents/infra.md` is edited to add the new grant\n"
      })
    ]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    await runToCompletion(orchestrator, runner);

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).not.toBe("blocked");
    const warningComment = (finalTask.comments ?? []).find((c) => c.text.includes(".claude/agents/infra.md"));
    expect(warningComment).toBeTruthy();
  });

  it("a PASS verdict (reviewer correctly recording an outstanding item) never touches round/no-progress/escalation bookkeeping", async () => {
    const store = makeStore([
      baseTask({
        body:
          "## Context\nUpdate docs.\n\n## Acceptance\n" +
          "- [ ] `npx vitest run` is green\n" +
          "- [ ] `.claude/agents/infra.md` is edited to document the new convention\n"
      })
    ]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    await runToCompletion(
      orchestrator,
      runner,
      "PASS",
      "vitest is green. The .claude/** edit item is outstanding -- owner: human -- per the structural-unsatisfiability rule."
    );

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
    // round/no-progress bookkeeping is FAIL/NEEDS_HUMAN_DECISION-only (see runOrchestrator.js's
    // _recordRoundWithoutDeliverable) -- a PASS must never increment it or park the card.
    expect(finalTask.round ?? 0).toBe(0);
    expect((finalTask.comments ?? []).some((c) => /ROUND CAP/i.test(c.text))).toBe(false);
  });

  it("round cap machinery is untouched by a PASS even after a prior settled round exists on the card", async () => {
    const store = makeStore([baseTask({ round: ROUND_CAP - 1 })]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    await runToCompletion(orchestrator, runner);

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("review");
    // _handlePass resets round to 0 on every PASS, regardless of what it carried in.
    expect(finalTask.round).toBe(0);
  });
});
