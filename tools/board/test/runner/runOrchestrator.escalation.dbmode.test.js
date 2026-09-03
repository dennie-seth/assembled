import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunOrchestrator, MAX_AUTO_RETRY_ATTEMPTS } from "../../src/runner/runOrchestrator.js";
import { openDb } from "../../src/lib/db/connection.js";
import { DbTaskStore } from "../../src/lib/db/dbTaskStore.js";

// T-0301: escalation was DEAD in db mode from the cutover.
//
// runOrchestrator.escalation.test.js already asserts the remediation card is `agent: "dispatch"`
// -- and passed the whole time -- because it drives a FAKE in-memory store with no CHECK
// constraint. Production runs a real SQLite DbTaskStore whose tasks.agent CHECK rejected
// 'dispatch', so every escalation INSERT failed with
//   "CHECK constraint failed: agent IN ('infra',...,'generic') OR agent IS NULL"
// the remediation card was never created, and the run just left the card blocked. Observed 11x
// in one day, end-to-end on T-0290.
//
// That gap -- a fake store standing in for the one component whose constraints were violated --
// is why this file exists: the SAME escalation flow, driven against a REAL database.

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

const ndjson = (event) => Buffer.from(`${JSON.stringify(event)}\n`);
const assistantEvent = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const verdictBlock = (verdict, notes) => `\`\`\`verdict\n${JSON.stringify({ verdict, notes })}\n\`\`\``;

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

const makeIdAllocator = (startAt = 2) => {
  let n = startAt;
  return { allocate: vi.fn(async () => `T-${String(n++).padStart(4, "0")}`) };
};

function makeRunLog() {
  const events = [];
  return { events, async append(e) { events.push(e); }, close: vi.fn(async () => {}) };
}

const makeGithub = () => ({
  checkAvailability: vi.fn(async () => ({ available: false, reason: "not-installed" })),
  findExistingPr: vi.fn(async () => null),
  createPr: vi.fn(async () => "https://github.com/example/repo/pull/1")
});

const makeGit = () => ({
  addWorktree: vi.fn(async () => ({ reused: false })),
  removeWorktree: vi.fn(async () => {}),
  diffNames: vi.fn(async () => ["tools/board/src/thing.js"]),
  commitAll: vi.fn(async () => true),
  push: vi.fn(async () => {}),
  getHeadCommit: vi.fn(async () => "abc1234def5678abc1234def5678abc1234def5"),
  linkBoardNodeModules: vi.fn(async () => {}),
  commitTaskFile: vi.fn(async () => true),
  autoCommitCardsOnCreateFromEnv: vi.fn(() => true)
});

function makeRunner() {
  const spawnedChildren = [];
  const start = vi.fn(async () => {
    const child = fakeChildProcess();
    spawnedChildren.push(child);
    return { runId: "run", child };
  });
  return { start, kill: vi.fn((run) => run.child.kill()), spawnedChildren };
}

async function nthChild(runner, n) {
  // Generous timeout on purpose: unlike the sibling escalation suite this drives a REAL
  // SQLite store, so each cycle does actual file I/O. Under the full 137-file run that can
  // exceed vi.waitFor's 1s default and flake, even though it passes comfortably in isolation.
  await vi.waitFor(() => expect(runner.start).toHaveBeenCalledTimes(n), { timeout: 15000 });
  return runner.spawnedChildren[n - 1];
}

function makeOrchestrator({ store, git, runner, hub, idAllocator, runLogs = [] }) {
  return new RunOrchestrator({
    store,
    hub: hub ?? { broadcast: vi.fn() },
    runner,
    git,
    github: makeGithub(),
    idAllocator,
    repoRoot: "/repo",
    worktreesDir: "/repo/worktrees",
    runsDir: "/repo/tasks/.runs",
    agentsDir: "/repo/.claude/agents",
    rulesDir: "/repo/.claude/rules",
    taskStoreKind: "db",
    loadAgentDefFn: (name) => (name === "reviewer" ? REVIEWER_DEF : IMPLEMENTER_DEF),
    loadRulesFn: () => [{ name: "conduct", paths: ["**"], body: "TDD." }],
    resolveAllowedToolsFn: (name) => (name === "reviewer" ? ["Read", "Grep"] : ["Read", "Write"]),
    createRunLogFn: vi.fn(async () => {
      const log = makeRunLog();
      runLogs.push(log);
      return log;
    }),
    crossCheckVerdictFn: ({ verdict }) => verdict
  });
}

async function exhaustToBlocked(runner) {
  for (let n = 1; n <= MAX_AUTO_RETRY_ATTEMPTS; n++) {
    const implChild = await nthChild(runner, n * 2 - 1);
    implChild.emit("exit", 0, null);
    const reviewChild = await nthChild(runner, n * 2);
    const notes =
      n === MAX_AUTO_RETRY_ATTEMPTS
        ? `issue round ${n} -- permission denied writing to /etc/hosts.`
        : `issue round ${n}`;
    reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("FAIL", notes))));
    reviewChild.emit("exit", 0, null);
  }
}

let tmpDir;
let db;
let store;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-escalation-db-"));
  db = openDb(path.join(tmpDir, "board.db"));
  store = new DbTaskStore(db);
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("escalation end-to-end against a REAL DbTaskStore (T-0301)", () => {
  it("creates a dispatch-owned remediation card in the database when auto-retry exhausts", async () => {
    await store.create(baseTask());
    const runner = makeRunner();
    const idAllocator = makeIdAllocator();
    const orchestrator = makeOrchestrator({ store, git: makeGit(), runner, idAllocator });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner);
    await runPromise;

    const original = await store.get("T-0001");
    expect(original.status).toBe("blocked");

    // the remediation card must actually be IN THE DATABASE -- this is what the CHECK
    // constraint rejected, so before 0004 the list came back with only T-0001
    const all = await store.list();
    const remediation = all.find((t) => t.id !== "T-0001");
    expect(remediation, "no remediation card was written to the database").toBeTruthy();
    expect(remediation.agent).toBe("dispatch");
    expect(remediation.status).toBe("ready");
    expect(remediation.body).toContain("<!-- escalation-remediation-for: T-0001 -->");

    // and it must survive a real round-trip through the DB, not just the create() return value
    expect((await store.get(remediation.id)).agent).toBe("dispatch");

    // the blocked card is linked to it
    expect(original.depends_on).toContain(remediation.id);
  });

  it("still records the blocker-report comment on the original card", async () => {
    await store.create(baseTask());
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({
      store, git: makeGit(), runner, idAllocator: makeIdAllocator()
    });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner);
    await runPromise;

    const original = await store.get("T-0001");
    const comment = original.comments.find((c) => c.text.includes("Blocker report"));
    expect(comment).toBeTruthy();
    expect(comment.author).toBe("assembled-board");
  });

  it("a dispatch-owned card round-trips through DbTaskStore directly", async () => {
    // the narrowest expression of the bug: the write escalation performs
    await store.create(baseTask({ id: "T-0500", agent: "dispatch", status: "ready" }));
    expect((await store.get("T-0500")).agent).toBe("dispatch");
  });
});
