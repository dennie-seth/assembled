import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { RunOrchestrator, MAX_AUTO_RETRY_ATTEMPTS } from "../../src/runner/runOrchestrator.js";
import { DbTaskStore } from "../../src/lib/db/dbTaskStore.js";
import { IdAllocatorDb } from "../../src/lib/db/idAllocatorDb.js";

const IMPLEMENTER_DEF = { name: "infra", model: "sonnet", body: "# infra\nImplements board tooling." };
const REVIEWER_DEF = { name: "reviewer", model: "opus", body: "# reviewer\nRead-only VALIDATION gate." };

function fakeChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.pid = 4242;
  child.kill = () => {
    queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
  };
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

function makeGithub() {
  return {
    checkAvailability: async () => ({ available: false, reason: "not-installed" }),
    findExistingPr: async () => null,
    createPr: async () => "https://github.com/example/repo/pull/1"
  };
}

function makeGit() {
  return {
    addWorktree: async () => ({ reused: false }),
    removeWorktree: async () => {},
    diffNames: async () => ["tools/board/src/thing.js"],
    commitAll: async () => true,
    push: async () => {},
    getHeadCommit: async () => "abc1234def5678abc1234def5678abc1234def5",
    linkBoardNodeModules: async () => {},
    commitTaskFile: async () => true,
    autoCommitCardsOnCreateFromEnv: () => true
  };
}

function makeRunner() {
  const spawnedChildren = [];
  return {
    start: async () => {
      const child = fakeChildProcess();
      spawnedChildren.push(child);
      return { runId: "run", child };
    },
    kill: (run) => run.child.kill(),
    spawnedChildren
  };
}

async function nthChild(runner, n) {
  // A generous timeout: under the full suite's parallel load (~135 files spawning workers
  // concurrently) a 1s default can starve before the microtask/event-loop turn that pushes the
  // next child runs, even though nothing is actually stuck -- see the sibling
  // runOrchestrator.escalation.test.js's identical nthChild for the pattern this mirrors.
  await vi.waitFor(() => expect(runner.spawnedChildren.length).toBeGreaterThanOrEqual(n), { timeout: 15000 });
  return runner.spawnedChildren[n - 1];
}

function makeRunLog() {
  const events = [];
  return {
    events,
    async append(event) {
      events.push(event);
    },
    close: async () => {}
  };
}

async function driveFailCycle(runner, n, notes) {
  const implChild = await nthChild(runner, n * 2 - 1);
  implChild.emit("exit", 0, null);
  const reviewChild = await nthChild(runner, n * 2);
  reviewChild.stdout.emit("data", ndjson(assistantEvent(verdictBlock("FAIL", notes ?? `issue round ${n}`))));
  reviewChild.emit("exit", 0, null);
}

async function exhaustToBlocked(runner) {
  for (let n = 1; n <= MAX_AUTO_RETRY_ATTEMPTS; n++) {
    await driveFailCycle(runner, n, n === MAX_AUTO_RETRY_ATTEMPTS ? "permission denied writing to /etc/hosts." : undefined);
  }
}

describe("RunOrchestrator escalation in real db mode -- reproduces the tasks.agent CHECK constraint bug", () => {
  it("actually persists a ready, dispatch-owned remediation card through DbTaskStore, readable back after exhausting retries", async () => {
    const dbStore = new DbTaskStore(":memory:");
    const idAllocator = new IdAllocatorDb(dbStore.db);
    try {
      await dbStore.create({
        id: "T-0001",
        title: "Do the thing",
        status: "ready",
        priority: "P1",
        phase: 2,
        agent: "infra",
        depends_on: [],
        created: "2026-08-01",
        body: "## Context\nDo it.\n\n## Acceptance\n- [ ] works\n",
        comments: []
      });
      // The original card's id doesn't come from idAllocator (it's a fixed fixture id) --
      // bump next_seq past it so the remediation card's real allocate() call can't collide with
      // it, the same way importer.js seeds next_seq from the highest pre-existing id in real data.
      dbStore.db.prepare("UPDATE id_allocator SET next_seq = 1").run();

      const runner = makeRunner();
      const orchestrator = new RunOrchestrator({
        store: dbStore,
        hub: { broadcast: () => {} },
        runner,
        git: makeGit(),
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
        resolveAllowedToolsFn: (name) => (name === "reviewer" ? ["Read", "Grep"] : ["Read", "Write", "Bash(git:*)"]),
        createRunLogFn: async () => makeRunLog(),
        crossCheckVerdictFn: ({ verdict }) => verdict
      });

      const runPromise = orchestrator.runCard("T-0001");
      await exhaustToBlocked(runner);
      await runPromise;

      const original = await dbStore.get("T-0001");
      expect(original.status).toBe("blocked");

      const comment = original.comments.find((c) => c.text.includes("Blocker report"));
      expect(comment).toBeTruthy();

      const allTasks = await dbStore.list();
      const remediation = allTasks.find((t) => t.id !== "T-0001");

      // This is the actual bug: without the CHECK constraint fix, DbTaskStore.create() throws
      // "CHECK constraint failed: agent IN (...)" when escalation tries to insert a card with
      // agent: "dispatch" -- caught, logged, and swallowed by _escalateIfGenuineBlocker, so no
      // remediation card is ever created and the original card just sits `blocked` forever.
      expect(remediation).toBeTruthy();
      expect(remediation.status).toBe("ready");
      expect(remediation.agent).toBe("dispatch");
      expect(remediation.body).toContain("<!-- escalation-remediation-for: T-0001 -->");

      // Read back through a *second*, independent get() call -- proves it's really persisted in
      // SQLite, not just an in-memory object handed back by create().
      const reread = await dbStore.get(remediation.id);
      expect(reread.agent).toBe("dispatch");
      expect(reread.status).toBe("ready");

      expect(original.depends_on).toContain(remediation.id);
    } finally {
      dbStore.close();
    }
  });
});
