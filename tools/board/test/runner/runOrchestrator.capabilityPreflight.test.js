import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { RunOrchestrator } from "../../src/runner/runOrchestrator.js";

const IMPLEMENTER_DEF = { name: "infra", model: "sonnet", body: "# infra\nImplements board tooling." };
const REVIEWER_DEF = { name: "reviewer", model: "opus", body: "# reviewer\nRead-only VALIDATION gate." };

// Mirrors the infra agent's real .claude/agents/infra.md grants -- no bare `pytest`, no ComfyUI.
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

describe("RunOrchestrator -- capability preflight (§23-b), runs before the implementer is spawned", () => {
  it("blocks a card whose AC names a checkpoint not in the installed capability inventory, without ever spawning the implementer", async () => {
    const store = makeStore([
      baseTask({
        body:
          "## Context\nGenerate a texture.\n\n## Acceptance\n" +
          "- [ ] Generation uses checkpoint `nonexistent_model_v3.safetensors` per the new workflow\n"
      })
    ]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    await orchestrator.runCard("T-0001");

    expect(runner.start).not.toHaveBeenCalled();

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.body).toContain("nonexistent_model_v3.safetensors");
    expect(finalTask.body).toContain("capabilityInventory.js");
  });

  it("blocks a card whose AC requires a command the assigned agent has no Bash grant for, without ever spawning the implementer", async () => {
    const store = makeStore([
      baseTask({
        body:
          "## Context\nAdd a python check.\n\n## Acceptance\n" +
          "- [ ] Run `pytest tools/board/test/foo_test.py` to confirm parity\n"
      })
    ]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    await orchestrator.runCard("T-0001");

    expect(runner.start).not.toHaveBeenCalled();

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.body).toContain("pytest");
    expect(finalTask.body).toContain(".claude/agents/infra.md");
  });

  it("spawns the implementer exactly as today when the AC is fully satisfiable", async () => {
    const store = makeStore([
      baseTask({
        body:
          "## Context\nAdd a vitest check.\n\n## Acceptance\n" + "- [ ] Run `npx vitest run` and confirm all green\n"
      })
    ]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

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

    expect(runner.start).toHaveBeenCalledTimes(2);
    const finalTask = await store.get("T-0001");
    expect(finalTask.status).not.toBe("blocked");
  });

  it("does not block a card whose AC only describes what CI runs, with no leading Run/Test cue (T-0031/T-0138 precedent)", async () => {
    const store = makeStore([
      baseTask({
        body:
          "## Context\nWire CI.\n\n## Acceptance\n" +
          "- [ ] `.github/workflows/ci-board.yml` runs `npm ci`, `npm run lint`, and `npx eslint .`\n"
      })
    ]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.waitFor(() => expect(runner.start).toHaveBeenCalledTimes(1));

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).not.toBe("blocked");

    // Clean up the still-running implementer phase so the test doesn't leak a pending run.
    runner.spawnedChildren[0].kill();
    await runPromise.catch(() => {});
  });
});
