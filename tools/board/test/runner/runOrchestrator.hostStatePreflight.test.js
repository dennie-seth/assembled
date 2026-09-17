import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { RunOrchestrator } from "../../src/runner/runOrchestrator.js";

const IMPLEMENTER_DEF = { name: "assets", model: "sonnet", body: "# assets\nGenerates curated 2D art." };
const REVIEWER_DEF = { name: "reviewer", model: "opus", body: "# reviewer\nRead-only VALIDATION gate." };

const HOST_ISSUE = {
  id: "example-host-issue",
  appliesToAgents: ["assets", "audio"],
  host: "Windows ComfyUI host (F:\\ComfyUI)",
  condition: "ComfyUI is launched without deterministic flags",
  action: "Edit start-comfyui.bat and restart ComfyUI.",
  reason: "No agent has a shell on this host.",
  verify: "Submit the same seed twice across two server lifetimes and confirm identical hashes.",
  resolved: false
};

function fakeChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.pid = 4242;
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
  });
  return child;
}

function baseTask(overrides = {}) {
  return {
    id: "T-0001",
    title: "Generate a texture",
    status: "ready",
    priority: "P1",
    phase: 2,
    agent: "assets",
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
    diffNames: vi.fn(async () => ["assets/final/thing.png"]),
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
    resolveAllowedToolsFn: (name) => (name === "reviewer" ? ["Read", "Grep"] : ["Read", "Write", "Bash(git:*)"]),
    createRunLogFn,
    crossCheckVerdictFn: ({ verdict }) => verdict,
    readVerdictEntriesFn: async () => [],
    appendVerdictEntryFn: async () => {},
    hostIssueRegistry: [HOST_ISSUE],
    ...overrides
  });
}

describe("RunOrchestrator -- host-state preflight (T-0323), runs before the implementer is spawned", () => {
  it("blocks a card whose agent matches a known unresolved host issue, without spawning the implementer, and escalates immediately", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const idAllocator = makeIdAllocator();
    const orchestrator = makeOrchestrator({ store, git, runner, idAllocator });

    await orchestrator.runCard("T-0001");

    expect(runner.start).not.toHaveBeenCalled();

    const original = await store.get("T-0001");
    expect(original.status).toBe("blocked");
    expect(original.body).toContain("host-action-request");

    const comment = original.comments.find((c) => c.text.includes("Blocker report"));
    expect(comment).toBeTruthy();
    expect(comment.text).toContain("Host action required");
    expect(comment.text).toContain(HOST_ISSUE.action);

    const allTasks = await store.list();
    const remediation = allTasks.find((t) => t.id !== "T-0001");
    expect(remediation).toBeTruthy();
    expect(remediation.status).toBe("ready");
    expect(remediation.agent).toBe("dispatch");
    expect(remediation.body).toContain("## Host action requested");
    expect(remediation.body).toContain(HOST_ISSUE.verify);

    expect(original.depends_on).toContain(remediation.id);
    expect(idAllocator.allocate).toHaveBeenCalledTimes(1);
  });

  it("spawns the implementer normally when no known host issue applies to the assigned agent", async () => {
    const store = makeStore([baseTask({ agent: "infra" })]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await vi.waitFor(() => expect(runner.start).toHaveBeenCalledTimes(1));

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).not.toBe("blocked");

    runner.spawnedChildren[0].kill();
    await runPromise.catch(() => {});
  });
});
