import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { RunOrchestrator } from "../../src/runner/runOrchestrator.js";
import { APPROVAL_LEDGER_RELATIVE_PATH } from "../../src/runner/approvalLedgerRegen.js";

/**
 * T-0313: `_handlePass` regenerates the committed approval ledger from the live store, inside the
 * card's own worktree, before that worktree's branch is pushed -- see docs/PLAN.md's card and
 * approvalLedgerRegen.js's docstring for why. This drives a real PASS through `RunOrchestrator`
 * with a real temp directory standing in for the card's worktree (so the ledger file is actually
 * read/written on disk) while every other git/gh operation stays mocked, the same split the
 * existing `runOrchestrator.approval.test.js` suite uses.
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
    // The live store this step reads: same interface exportApprovalLedger.js's script already
    // consults (FsTaskStore/DbTaskStore.list()).
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
    id: "T-0257",
    title: "Signal Tower prop concept art",
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
    crossCheckVerdictFn: ({ verdict }) => verdict
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

describe("T-0313: approval ledger regeneration on PASS", () => {
  let worktreesDir;
  let worktreeDir;
  let ledgerPath;

  beforeEach(async () => {
    worktreesDir = await fs.mkdtemp(path.join(tmpdir(), "board-ledger-regen-"));
    worktreeDir = path.join(worktreesDir, "T-0257");
    ledgerPath = path.join(worktreeDir, APPROVAL_LEDGER_RELATIVE_PATH);
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(worktreesDir, { recursive: true, force: true });
  });

  it("regenerates the ledger from the live store before the branch is pushed, from a fake store whose approval state differs from the committed ledger", async () => {
    // The committed ledger is exactly the T-0273 incident's stale snapshot: recorded unapproved
    // while the live store (below) already shows a real human approval.
    await fs.writeFile(
      ledgerPath,
      JSON.stringify({
        version: 1,
        generated_at: "2026-09-03T13:00:22.804Z",
        cards: [{ id: "T-0257", requires_approval: true, approved_by: null, approved_at: null }]
      })
    );

    let pushedLedgerContent = null;
    const store = makeStore([
      baseTask({ requires_approval: true, approved_by: "DennieSeth", approved_at: "2026-09-03T17:52:21.435Z" })
    ]);
    const git = makeGit({
      push: vi.fn(async ({ worktreeDir: wd }) => {
        // Captured at push time -- proves regeneration already happened before this call, not after.
        pushedLedgerContent = await fs.readFile(path.join(wd, APPROVAL_LEDGER_RELATIVE_PATH), "utf8");
      })
    });
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner, worktreesDir });

    await runToPass(orchestrator, runner, "T-0257");

    expect(pushedLedgerContent).not.toBeNull();
    const parsed = JSON.parse(pushedLedgerContent);
    expect(parsed.cards).toEqual([
      { id: "T-0257", requires_approval: true, approved_by: "DennieSeth", approved_at: "2026-09-03T17:52:21.435Z" }
    ]);

    const onDisk = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
    expect(onDisk.cards).toEqual(parsed.cards);
  });

  it("does not touch the ledger file at all when the live store already matches it", async () => {
    const cards = [{ id: "T-0257", requires_approval: false, approved_by: null, approved_at: null }];
    const before = `${JSON.stringify({ version: 1, generated_at: "2026-09-01T00:00:00.000Z", cards }, null, 2)}\n`;
    await fs.writeFile(ledgerPath, before);

    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner, worktreesDir });

    await runToPass(orchestrator, runner, "T-0257");

    const after = await fs.readFile(ledgerPath, "utf8");
    expect(after).toBe(before);
  });

  it("logs a failure inside ledger regeneration but does not fail the PASS, block the push, or lose the PR", async () => {
    // Delete the parent directory so the write itself throws (ENOENT) -- stands in for a real
    // export failure (disk full, DB locked) without needing to actually fill a disk.
    await fs.rm(path.join(worktreeDir, "tools"), { recursive: true, force: true });

    const store = makeStore([
      baseTask({ requires_approval: true, approved_by: "DennieSeth", approved_at: "2026-09-03T17:52:21.435Z" })
    ]);
    const git = makeGit();
    const runner = makeRunner();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const orchestrator = makeOrchestrator({ store, git, runner, worktreesDir });

    await runToPass(orchestrator, runner, "T-0257");

    const task = await store.get("T-0257");
    expect(task.status).toBe("review");
    expect(git.push).toHaveBeenCalled();
    expect(
      errorSpy.mock.calls.some(([msg]) => typeof msg === "string" && msg.includes("approval ledger regeneration failed"))
    ).toBe(true);

    errorSpy.mockRestore();
  });
});
