import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { RunOrchestrator } from "../../src/runner/runOrchestrator.js";

const IMPLEMENTER_DEF = { name: "infra", model: "sonnet", body: "# infra\nImplements board tooling." };
const REVIEWER_DEF = { name: "reviewer", model: "opus", body: "# reviewer\nRead-only VALIDATION gate." };

// Mirrors the infra agent's real .claude/agents/infra.md grants -- no systemctl, no journalctl.
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
    ...overrides
  });
}

async function runToCompletion(orchestrator, runner) {
  const runPromise = orchestrator.runCard("T-0001");
  await vi.waitFor(() => expect(runner.start).toHaveBeenCalledTimes(1));

  const implChild = runner.spawnedChildren[0];
  implChild.emit("exit", 0, null);
  const reviewChild = await vi.waitFor(() => {
    expect(runner.start).toHaveBeenCalledTimes(2);
    return runner.spawnedChildren[1];
  });
  reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("PASS", "all good"))));
  reviewChild.emit("exit", 0, null);
  await runPromise;
}

describe("RunOrchestrator -- unsatisfiable-AC preflight (T-0300), warns but never blocks", () => {
  it("still spawns the implementer AND posts a warning comment for a human-observation criterion", async () => {
    const store = makeStore([
      baseTask({
        body:
          "## Context\nAdd drag auto-scroll.\n\n## Acceptance\n" +
          "- [ ] Drag a tall card near the column edge and say what you observed -- do not infer it from the code\n"
      })
    ]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    await runToCompletion(orchestrator, runner);

    // Never blocked, and the implementer genuinely ran -- this is a warning, not a hard block.
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).not.toBe("blocked");

    const warningComment = (finalTask.comments ?? []).find((c) => c.text.includes("say what you observed"));
    expect(warningComment).toBeTruthy();
    expect(warningComment.author).toBe("assembled-board");
    expect(warningComment.text).toContain("warning, not a block");
  });

  it("still spawns the implementer AND posts a warning comment for an ungranted systemctl mention", async () => {
    const store = makeStore([
      baseTask({
        body:
          "## Context\nMeasure restart time.\n\n## Acceptance\n" +
          "- [ ] Run `systemctl --user restart assembled-board` and record the measured stop duration\n"
      })
    ]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    await runToCompletion(orchestrator, runner);

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).not.toBe("blocked");
    const warningComment = (finalTask.comments ?? []).find((c) => c.text.includes("systemctl"));
    expect(warningComment).toBeTruthy();
  });

  it("posts no extra warning comment when the AC is fully satisfiable", async () => {
    const store = makeStore([
      baseTask({
        body: "## Context\nAdd a vitest check.\n\n## Acceptance\n" + "- [ ] Run `npx vitest run` and confirm all green\n"
      })
    ]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    await runToCompletion(orchestrator, runner);

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).not.toBe("blocked");
    expect(finalTask.comments ?? []).toEqual([]);
  });
});
