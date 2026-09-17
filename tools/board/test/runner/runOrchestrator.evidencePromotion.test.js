import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { RunOrchestrator } from "../../src/runner/runOrchestrator.js";

/**
 * T-0314: `_handlePass` promotes an asset run's decisive attempt frames into
 * `docs/assets/evidence/<card>/` -- automatically, from the card's own worktree, before that
 * worktree's branch is committed and pushed -- so the frames ride the same PR and survive the
 * worktree being removed a few lines later in `_handlePass`. See evidencePromotion.js and
 * docs/assets/evidence-promotion.md. This drives a real PASS through `RunOrchestrator` with a
 * real temp directory standing in for the card's worktree (so the promoted files are actually
 * written to disk), the same split `runOrchestrator.approvalLedgerRegen.test.js` uses for the
 * sibling pre-commit step.
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
    async append(event) {
      events.push(event);
    },
    close: vi.fn(async () => {})
  };
}

function baseTask(overrides = {}) {
  return {
    id: "T-0272",
    title: "Hybrid profile character sheet",
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

function makeOrchestrator({ store, git, runner, worktreesDir }) {
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
  implChild.stdout.emit("data", ndjson(assistantEvent("generating...")));
  implChild.emit("exit", 0, null);

  const reviewChild = await nthChild(runner, 2);
  reviewChild.stdout.emit("data", ndjson(assistantEvent(`Reviewed. ${verdictBlock("PASS", "sheet produced")}`)));
  reviewChild.emit("exit", 0, null);

  await runPromise;
}

describe("T-0314: evidence promotion on PASS", () => {
  let worktreesDir;
  let worktreeDir;

  beforeEach(async () => {
    worktreesDir = await fs.mkdtemp(path.join(tmpdir(), "board-evidence-promo-"));
    worktreeDir = path.join(worktreesDir, "T-0272");
    await fs.mkdir(worktreeDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(worktreesDir, { recursive: true, force: true });
  });

  it("promotes the round's cited decisive frame into docs/assets/evidence/<card>/ before the branch is pushed -- the FINDING case, nothing promoted to assets/final", async () => {
    await fs.mkdir(path.join(worktreeDir, "assets/out/hybrid_profile/attempt_14"), { recursive: true });
    await fs.writeFile(path.join(worktreeDir, "assets/out/hybrid_profile/attempt_14/main_384.png"), "the-decisive-frame");
    await fs.mkdir(path.join(worktreeDir, "assets/src/character"), { recursive: true });
    await fs.writeFile(
      path.join(worktreeDir, "assets/src/character/ARM_HYBRID_ATTEMPT_LOG_T0272.md"),
      "**Not promoted.** The decisive frame is `attempt_14/main_384.png`."
    );

    let pushedEvidence = null;
    const store = makeStore([baseTask()]);
    const git = makeGit({
      push: vi.fn(async ({ worktreeDir: wd }) => {
        pushedEvidence = await fs
          .readFile(path.join(wd, "docs/assets/evidence/T-0272/attempt_14_main_384.png"))
          .catch(() => null);
      })
    });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner, worktreesDir });

    await runToPass(orchestrator, runner, "T-0272");

    expect(pushedEvidence).toEqual(Buffer.from("the-decisive-frame"));
    const onDisk = await fs.readFile(path.join(worktreeDir, "docs/assets/evidence/T-0272/attempt_14_main_384.png"));
    expect(onDisk).toEqual(Buffer.from("the-decisive-frame"));
  });

  it("does nothing, and never logs an error, for a card that never touched assets/** -- no attempt log, no assets/out tree", async () => {
    const store = makeStore([baseTask({ agent: "infra" })]);
    const git = makeGit();
    const runner = makeRunner();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const orchestrator = makeOrchestrator({ store, git, runner, worktreesDir });

    await runToPass(orchestrator, runner, "T-0272");

    expect(await fs.readdir(worktreeDir).catch(() => [])).not.toContain("docs");
    expect(
      errorSpy.mock.calls.some(([msg]) => typeof msg === "string" && msg.includes("evidence promotion"))
    ).toBe(false);

    errorSpy.mockRestore();
  });

  it("logs a failure inside evidence promotion but does not fail the PASS, block the push, or lose the PR", async () => {
    // A citation that names a run dir that never got created must not throw all the way out --
    // covered at the library level too, but this proves the orchestrator's own wrapper degrades
    // the same way rather than letting a surprise crash reach the PASS commit/push.
    await fs.mkdir(path.join(worktreeDir, "assets/src/character"), { recursive: true });
    await fs.writeFile(
      path.join(worktreeDir, "assets/src/character/ARM_HYBRID_ATTEMPT_LOG_T0272.md"),
      "Decisive: `attempt_1/main_384.png`."
    );
    // assets/out deliberately never created -- the run crashed before generating anything.

    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();

    const orchestrator = makeOrchestrator({ store, git, runner, worktreesDir });

    await runToPass(orchestrator, runner, "T-0272");

    const task = await store.get("T-0272");
    expect(task.status).toBe("review");
    expect(git.push).toHaveBeenCalled();
  });
});
