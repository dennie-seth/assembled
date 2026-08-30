import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { RunOrchestrator } from "../../src/runner/runOrchestrator.js";
import { ApprovalRequiredError, isApprovalMarker } from "../../src/lib/approvalGate.js";

/**
 * The runner half of the human direction-approval gate (docs/board-invariants.md §9).
 *
 * Two claims, and they are different claims:
 *  - AP-2: a PASS on an approval-gated card settles it into the parked status and *says so* on
 *    the card, rather than completing it. The status half is what keeps dependents blocked; the
 *    comment half is what stops "parked" from being indistinguishable from "waiting on a PR".
 *  - AP-2b: no automated write can complete such a card at all. Today nothing tries -- this is
 *    the guard that keeps it that way as run paths are added.
 */

const IMPLEMENTER_DEF = { name: "assets", model: "sonnet", body: "# assets\nProduces art." };
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
    id: "T-0257",
    title: "Signal Tower prop concept art — real, for approval",
    status: "ready",
    priority: "P1",
    phase: 2,
    agent: "assets",
    depends_on: [],
    created: "2026-08-29",
    comments: [],
    requires_approval: false,
    approved_by: null,
    approved_at: null,
    body: "## Context\nGenerate it.\n\n## Acceptance\n- [ ] a sheet exists\n",
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
  const start = vi.fn(async () => {
    const child = fakeChildProcess();
    spawnedChildren.push(child);
    return { runId: "run", child };
  });
  return { start, kill: vi.fn((run) => run.child.kill()), spawnedChildren };
}

function makeOrchestrator({ store, git, runner, hub } = {}) {
  return new RunOrchestrator({
    store,
    hub: hub ?? { broadcast: vi.fn() },
    runner,
    git,
    github: {
      checkAvailability: vi.fn(async () => ({ available: false, reason: "not-installed" })),
      findExistingPr: vi.fn(async () => null),
      createPr: vi.fn(async () => "https://github.com/example/repo/pull/1")
    },
    repoRoot: "/repo",
    worktreesDir: "/repo/worktrees",
    runsDir: "/repo/tasks/.runs",
    agentsDir: "/repo/.claude/agents",
    rulesDir: "/repo/.claude/rules",
    loadAgentDefFn: (name) => (name === "reviewer" ? REVIEWER_DEF : IMPLEMENTER_DEF),
    loadRulesFn: () => [{ name: "conduct", paths: ["**"], body: "TDD." }],
    resolveAllowedToolsFn: () => ["Read", "Write"],
    createRunLogFn: vi.fn(async () => makeRunLog()),
    crossCheckVerdictFn: ({ verdict }) => verdict
  });
}

async function nthChild(runner, n) {
  await vi.waitFor(() => expect(runner.start).toHaveBeenCalledTimes(n));
  return runner.spawnedChildren[n - 1];
}

/** Drives a card through a full implementer + reviewer PASS run. */
async function runToPass(orchestrator, runner, id) {
  const runPromise = orchestrator.runCard(id);

  const implChild = await nthChild(runner, 1);
  implChild.stdout.emit("data", ndjson(assistantEvent("generating...")));
  implChild.emit("exit", 0, null);

  const reviewChild = await nthChild(runner, 2);
  reviewChild.stdout.emit("data", ndjson(assistantEvent(`Reviewed. ${verdictBlock("PASS", "sheet produced")}`)));
  reviewChild.emit("exit", 0, null);

  await runPromise;
}

describe("AP-2: a PASS on an approval-gated card parks it instead of completing it", () => {
  it("leaves the card in review, unapproved, with the artifact metadata a normal PASS records", async () => {
    const store = makeStore([baseTask({ requires_approval: true })]);
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git: makeGit(), runner });

    await runToPass(orchestrator, runner, "T-0257");

    const task = await store.get("T-0257");
    expect(task.status).toBe("review");
    expect(task.approved_by).toBe(null);
    expect(task.approved_at).toBe(null);
    // The gate parks the card; it does not degrade the run. The branch/commit a PASS records
    // are still there, so approving it later needs no re-run.
    expect(task.branch).toBe("feature/T-0257");
    expect(task.commit).toBe("abc1234def5678abc1234def5678abc1234def5");
  });

  it("posts the PARKED FOR HUMAN APPROVAL comment, naming both exits", async () => {
    const store = makeStore([baseTask({ requires_approval: true })]);
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git: makeGit(), runner });

    await runToPass(orchestrator, runner, "T-0257");

    const { comments } = await store.get("T-0257");
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe("assembled-board");
    expect(comments[0].text).toMatch(/PARKED FOR HUMAN APPROVAL/);
    expect(comments[0].text).toMatch(/move this card to Done/i);
    expect(comments[0].text).toMatch(/re-run/i);
  });

  it("posts a notice that is not itself an approval marker -- the board never approves for a human", async () => {
    const store = makeStore([baseTask({ requires_approval: true })]);
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git: makeGit(), runner });

    await runToPass(orchestrator, runner, "T-0257");

    const { comments } = await store.get("T-0257");
    expect(isApprovalMarker(comments[0].text)).toBe(false);
  });

  it("leaves an ordinary card's PASS completely unchanged -- review, and no parked comment", async () => {
    const store = makeStore([baseTask()]);
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git: makeGit(), runner });

    await runToPass(orchestrator, runner, "T-0257");

    const task = await store.get("T-0257");
    expect(task.status).toBe("review");
    expect(task.comments).toEqual([]);
  });

  it("does not re-post the notice on a card a human has already approved", async () => {
    const store = makeStore([
      baseTask({ requires_approval: true, approved_by: "DennieSeth", approved_at: "2026-08-30T00:00:00.000Z" })
    ]);
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git: makeGit(), runner });

    await runToPass(orchestrator, runner, "T-0257");

    expect((await store.get("T-0257")).comments).toEqual([]);
  });
});

describe("AP-2b: no automated write can complete an approval-gated card", () => {
  it("refuses a status: done write from the orchestrator's own update path", async () => {
    const store = makeStore([baseTask({ requires_approval: true, status: "review" })]);
    const orchestrator = makeOrchestrator({ store, git: makeGit(), runner: makeRunner() });

    await expect(orchestrator._updateAndBroadcast("T-0257", { status: "done" })).rejects.toThrow(
      ApprovalRequiredError
    );
    expect((await store.get("T-0257")).status).toBe("review");
  });

  it("allows the same write once a human approval is recorded on the card", async () => {
    const store = makeStore([
      baseTask({
        requires_approval: true,
        status: "review",
        approved_by: "DennieSeth",
        approved_at: "2026-08-30T00:00:00.000Z"
      })
    ]);
    const orchestrator = makeOrchestrator({ store, git: makeGit(), runner: makeRunner() });

    await orchestrator._updateAndBroadcast("T-0257", { status: "done" });

    expect((await store.get("T-0257")).status).toBe("done");
  });

  it("allows a status: done write on a card that was never gated", async () => {
    const store = makeStore([baseTask({ status: "review" })]);
    const orchestrator = makeOrchestrator({ store, git: makeGit(), runner: makeRunner() });

    await orchestrator._updateAndBroadcast("T-0257", { status: "done" });

    expect((await store.get("T-0257")).status).toBe("done");
  });
});
