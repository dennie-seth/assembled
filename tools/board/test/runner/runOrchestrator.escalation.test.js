import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { RunOrchestrator, MAX_AUTO_RETRY_ATTEMPTS } from "../../src/runner/runOrchestrator.js";

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

/** Richer than the main test file's mock -- also supports list()/create() for escalation's dedupe + remediation-card creation. */
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

function makeStoreWithoutList(initialTasks) {
  // eslint-disable-next-line no-unused-vars -- destructure-omit is the concise way to drop `list`
  const { list, ...rest } = makeStore(initialTasks);
  return rest;
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

async function nthChild(runner, n) {
  await vi.waitFor(() => expect(runner.start).toHaveBeenCalledTimes(n));
  return runner.spawnedChildren[n - 1];
}

function makeOrchestrator({ store, git, runner, hub, github, idAllocator, taskStoreKind = "db", runLogs = [], verdictArchives, ...overrides } = {}) {
  const createRunLogFn = vi.fn(async () => {
    const log = makeRunLog();
    runLogs.push(log);
    return log;
  });

  const archives = verdictArchives ?? new Map();

  const orchestrator = new RunOrchestrator({
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
    taskStoreKind,
    loadAgentDefFn: (name) => (name === "reviewer" ? REVIEWER_DEF : IMPLEMENTER_DEF),
    loadRulesFn: () => [{ name: "conduct", paths: ["**"], body: "TDD." }],
    resolveAllowedToolsFn: (name) => (name === "reviewer" ? ["Read", "Grep"] : ["Read", "Write", "Bash(git:*)"]),
    createRunLogFn,
    // Not exercising the harness-side verdict cross-check here (see verdictCrossCheck.test.js
    // and runOrchestrator.test.js's dedicated describe block) -- default to a passthrough.
    crossCheckVerdictFn: ({ verdict }) => verdict,
    readVerdictEntriesFn: async (tasksDir, id) => archives.get(id) ?? [],
    appendVerdictEntryFn: async (tasksDir, id, entry) => {
      const list = archives.get(id) ?? [];
      list.push(entry);
      archives.set(id, list);
    },
    // T-0367 fix round: ensureExecutionIdFn is awaited directly at the top of runCard() -- avoid
    // real filesystem I/O against this file's fake "/repo" paths on that critical path.
    ensureExecutionIdFn: vi.fn(async () => "exec-test"),
    clearExecutionIdFn: vi.fn(async () => {}),
    ...overrides
  });
  orchestrator.testVerdictArchives = archives;
  return orchestrator;
}

/**
 * Drives the nth implementer+reviewer cycle to a FAIL verdict.
 * `reviewerPreamble` is raw chatter emitted *outside* the ```verdict fenced block -- for
 * simulating prose that merely quotes a usage/rate-limit phrase without any request actually
 * having been refused (T-0377: this must never suppress escalation on its own). `notesOverride`
 * replaces the verdict's own `notes` field -- for simulating what the reviewer actually wrote
 * about why it failed (the text the blocker-report categorizer reads). `extraEvents` are raw
 * NDJSON events emitted before the verdict block, for structured signals (`rate_limit_event`,
 * a terminal 429 `result`, an explicit `error` code) that a real refusal would carry.
 */
async function driveFailCycle(runner, n, { reviewerPreamble = "", notesOverride, extraEvents = [] } = {}) {
  const implChild = await nthChild(runner, n * 2 - 1);
  implChild.emit("exit", 0, null);
  const reviewChild = await nthChild(runner, n * 2);
  const notes = notesOverride ?? `issue round ${n}`;
  for (const event of extraEvents) reviewChild.stdout.emit("data", ndjson(event));
  reviewChild.stdout.emit("data", ndjson(assistantEvent(`${reviewerPreamble}${verdictBlock("FAIL", notes)}`)));
  reviewChild.emit("exit", 0, null);
  return { implChild, reviewChild };
}

async function exhaustToBlocked(
  runner,
  { reviewerPreambleForAttempt, notesOverrideForAttempt, extraEventsForAttempt } = {}
) {
  for (let n = 1; n <= MAX_AUTO_RETRY_ATTEMPTS; n++) {
    const preamble = reviewerPreambleForAttempt && reviewerPreambleForAttempt(n);
    const notesOverride = notesOverrideForAttempt && notesOverrideForAttempt(n);
    const extraEvents = extraEventsForAttempt && extraEventsForAttempt(n);
    await driveFailCycle(runner, n, {
      reviewerPreamble: preamble ?? "",
      notesOverride,
      extraEvents: extraEvents ?? []
    });
  }
}

describe("RunOrchestrator escalation -- genuine blocker after auto-retry exhausts", () => {
  it("appends a structured blocker-report comment and creates a ready, dispatch-owned remediation card linked as a dependency", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const hub = { broadcast: vi.fn() };
    const idAllocator = makeIdAllocator();
    const orchestrator = makeOrchestrator({ store, git, runner, hub, idAllocator });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner, {
      notesOverrideForAttempt: (n) =>
        n === MAX_AUTO_RETRY_ATTEMPTS ? `issue round ${n} -- permission denied writing to /etc/hosts.` : undefined
    });
    await runPromise;

    const original = await store.get("T-0001");
    expect(original.status).toBe("blocked");

    const comment = original.comments.find((c) => c.text.includes("Blocker report"));
    expect(comment).toBeTruthy();
    expect(comment.author).toBe("assembled-board");
    expect(comment.text).toContain("Permission/grant");
    expect(comment.text).toContain("issue round 1");
    expect(comment.text).toContain(`issue round ${MAX_AUTO_RETRY_ATTEMPTS}`);

    const allTasks = await store.list();
    const remediation = allTasks.find((t) => t.id !== "T-0001");
    expect(remediation).toBeTruthy();
    expect(remediation.status).toBe("ready");
    expect(remediation.agent).toBe("dispatch");
    expect(remediation.body).toContain("<!-- escalation-remediation-for: T-0001 -->");

    expect(original.depends_on).toContain(remediation.id);
    expect(idAllocator.allocate).toHaveBeenCalledTimes(1);
  });

  it("never spawns an extra runner call for escalation -- exactly implementer+reviewer runs, never more", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner);
    await runPromise;

    expect(runner.start).toHaveBeenCalledTimes(MAX_AUTO_RETRY_ATTEMPTS * 2);
  });

  it("categorizes a missing-tool blocker from the reviewer's FAIL notes", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner, {
      notesOverrideForAttempt: (n) =>
        n === MAX_AUTO_RETRY_ATTEMPTS ? `issue round ${n} -- Error: unknown tool 'Godot' in this environment.` : undefined
    });
    await runPromise;

    const remediation = (await store.list()).find((t) => t.id !== "T-0001");
    expect(remediation.body).toContain("Tool");
  });
});

/** Real 429 session-limit stop shape (card evidence, T-0366-2026-09-11T18-15-10-554Z.jsonl). */
function quotaStopResultEvent() {
  return {
    type: "result",
    is_error: true,
    terminal_reason: "api_error",
    api_error_status: 429,
    result: "You've hit your session limit · resets 6pm (Europe/Budapest)",
    total_cost_usd: 1.42,
    usage: { input_tokens: 12000, output_tokens: 3400, cache_creation_input_tokens: 500, cache_read_input_tokens: 8000 }
  };
}

describe("RunOrchestrator escalation -- quoted usage/rate-limit prose never suppresses a genuine FAIL (T-0377 / PR #381)", () => {
  it("still escalates when a reviewer's raw preamble merely quotes 'usage limit reached' text", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    // The quoted phrase shows up mid-way through the exhausted attempts -- no request was ever
    // actually refused, so this must not suppress escalation.
    await exhaustToBlocked(runner, {
      reviewerPreambleForAttempt: (n) => (n === 3 ? "Claude AI usage limit reached. Your limit will reset at 5pm. " : "")
    });
    await runPromise;

    const original = await store.get("T-0001");
    expect(original.status).toBe("blocked");
    expect(original.comments.find((c) => c.text.includes("Blocker report"))).toBeTruthy();
    expect(await store.list()).toHaveLength(2);
  });

  it("still escalates when a reviewer's raw preamble merely quotes a 429/rate-limited phrase", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner, {
      reviewerPreambleForAttempt: (n) => (n === MAX_AUTO_RETRY_ATTEMPTS ? "Request failed with status 429 (rate limited). " : "")
    });
    await runPromise;

    const original = await store.get("T-0001");
    expect(original.comments.find((c) => c.text.includes("Blocker report"))).toBeTruthy();
    expect(await store.list()).toHaveLength(2);
  });

  it("does not suppress escalation for the real T-0367 shape: completed results, healthy telemetry, repeatedly-quoted session-limit text", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner, {
      // Every attempt's own reviewer round completes normally (verdictBlock always emits a
      // `result`-shaped assistant text, never a terminal api_error/429) while quoting the T-0366
      // refusal phrase verbatim in the reviewer's raw preamble -- exactly what T-0367/PR #381's
      // docs, fixtures and reviewer notes did 39 times over.
      reviewerPreambleForAttempt: () => "Fixture asserts the CLI's \"You've hit your session limit\" text is handled correctly. ",
      extraEventsForAttempt: () => [{ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour" }, session_id: "s-1" }]
    });
    await runPromise;

    const original = await store.get("T-0001");
    expect(original.status).toBe("blocked");
    expect(original.comments.find((c) => c.text.includes("Blocker report"))).toBeTruthy();
    expect(await store.list()).toHaveLength(2);
  });
});

describe("RunOrchestrator escalation -- a genuine structured usage-limit stop still suppresses", () => {
  it("suppresses escalation when an attempt's own result event is a genuine terminal 429 api_error stop", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner, {
      extraEventsForAttempt: (n) => (n === MAX_AUTO_RETRY_ATTEMPTS ? [quotaStopResultEvent()] : [])
    });
    await runPromise;

    const original = await store.get("T-0001");
    expect(original.status).toBe("blocked");
    expect(original.comments).toEqual([]);
    expect(original.depends_on).toEqual([]);
    expect(await store.list()).toHaveLength(1);
  });

  it("suppresses escalation when an attempt carries an explicit rate_limit error code with no prose at all", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner, {
      extraEventsForAttempt: (n) => (n === MAX_AUTO_RETRY_ATTEMPTS ? [{ type: "assistant", error: "rate_limit" }] : [])
    });
    await runPromise;

    expect(await store.list()).toHaveLength(1);
  });

  it("names the structured signal that triggered escalation suppression in the run log", async () => {
    const store = makeStore([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const runLogs = [];
    const orchestrator = makeOrchestrator({ store, git, runner, runLogs });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner, {
      extraEventsForAttempt: (n) => (n === MAX_AUTO_RETRY_ATTEMPTS ? [quotaStopResultEvent()] : [])
    });
    await runPromise;

    const log = runLogs.at(-1);
    const escalationEvent = log.events.find((e) => e.type === "escalation");
    expect(escalationEvent).toBeTruthy();
    expect(escalationEvent.message).toMatch(/api_error/);
    expect(escalationEvent.message).toMatch(/429/);
  });
});

describe("RunOrchestrator escalation -- dedupe and idempotent dependency wiring", () => {
  it("does not create a second remediation card when one already exists for this blocked card, but still wires the dependency", async () => {
    const existing = {
      id: "T-0050",
      title: "Unblock T-0001",
      status: "ready",
      priority: "P2",
      phase: 0,
      agent: "dispatch",
      depends_on: [],
      created: "2026-08-01",
      comments: [],
      body: "<!-- escalation-remediation-for: T-0001 -->\n\nAlready escalated once."
    };
    const store = makeStore([baseTask(), existing]);
    const git = makeGit();
    const runner = makeRunner();
    const idAllocator = makeIdAllocator();
    const orchestrator = makeOrchestrator({ store, git, runner, idAllocator });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner);
    await runPromise;

    expect(idAllocator.allocate).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(2);
    expect((await store.get("T-0001")).depends_on).toEqual(["T-0050"]);
  });

  it("does not duplicate the dependency edge if it is already wired from a prior escalation", async () => {
    const existing = {
      id: "T-0050",
      title: "Unblock T-0001",
      status: "ready",
      priority: "P2",
      phase: 0,
      agent: "dispatch",
      depends_on: [],
      created: "2026-08-01",
      comments: [],
      body: "<!-- escalation-remediation-for: T-0001 -->\n\nAlready escalated once."
    };
    const store = makeStore([baseTask({ depends_on: ["T-0050"] }), existing]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner);
    await runPromise;

    expect((await store.get("T-0001")).depends_on).toEqual(["T-0050"]);
  });

  it("still re-links (no duplicate) when the existing remediation card is open but already in-progress", async () => {
    const existing = {
      id: "T-0050",
      title: "Unblock T-0001",
      status: "in-progress",
      priority: "P2",
      phase: 0,
      agent: "dispatch",
      depends_on: [],
      created: "2026-08-01",
      comments: [],
      body: "<!-- escalation-remediation-for: T-0001 -->\n\nAlready escalated once."
    };
    const store = makeStore([baseTask(), existing]);
    const runner = makeRunner();
    const idAllocator = makeIdAllocator();
    const orchestrator = makeOrchestrator({ store, git: makeGit(), runner, idAllocator });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner);
    await runPromise;

    expect(idAllocator.allocate).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(2);
    expect((await store.get("T-0001")).depends_on).toEqual(["T-0050"]);
  });
});

describe("RunOrchestrator escalation -- dedupe re-checks the existing remediation card's status (T-0310)", () => {
  function retiredRemediation(overrides = {}) {
    return {
      id: "T-0050",
      title: "Unblock T-0001",
      status: "retired",
      priority: "P2",
      phase: 0,
      agent: "dispatch",
      depends_on: [],
      created: "2026-08-01",
      comments: [],
      body: "<!-- escalation-remediation-for: T-0001 -->\n\nRetired: premise was void.",
      ...overrides
    };
  }

  for (const closedStatus of ["retired", "done"]) {
    it(`creates a fresh remediation card and re-links to it, instead of a ${closedStatus} one, carrying the CURRENT blocker report`, async () => {
      const existing = retiredRemediation({ status: closedStatus });
      const store = makeStore([baseTask({ depends_on: [existing.id] }), existing]);
      const runner = makeRunner();
      const idAllocator = makeIdAllocator(51);
      const runLogs = [];
      const orchestrator = makeOrchestrator({ store, git: makeGit(), runner, idAllocator, runLogs });

      const runPromise = orchestrator.runCard("T-0001");
      await exhaustToBlocked(runner, {
        notesOverrideForAttempt: (n) =>
          n === MAX_AUTO_RETRY_ATTEMPTS ? `issue round ${n} -- fresh blocker: ECONNREFUSED talking to the reference service.` : undefined
      });
      await runPromise;

      expect(idAllocator.allocate).toHaveBeenCalledTimes(1);

      const original = await store.get("T-0001");
      const allTasks = await store.list();
      const fresh = allTasks.find((t) => t.id !== "T-0001" && t.id !== existing.id);

      expect(fresh).toBeTruthy();
      expect(fresh.status).toBe("ready");
      expect(fresh.agent).toBe("dispatch");
      expect(fresh.body).toContain("<!-- escalation-remediation-for: T-0001 -->");
      // The new card must carry the CURRENT report, not the closed card's old context.
      expect(fresh.body).toContain("ECONNREFUSED talking to the reference service");
      expect(fresh.body).not.toContain("premise was void");

      // The parent is never left depending on the closed card -- the stale entry is replaced,
      // not accumulated alongside the new one.
      expect(original.depends_on).toEqual([fresh.id]);
      expect(original.depends_on).not.toContain(existing.id);

      const messages = runLogs[0].events.filter((e) => e.type === "escalation").map((e) => e.message);
      expect(messages.some((m) => m.includes(existing.id) && new RegExp(closedStatus, "i").test(m))).toBe(true);
    });
  }

  it("re-links to the existing card without creating a duplicate when it is still open", async () => {
    const existing = retiredRemediation({ status: "ready" });
    const store = makeStore([baseTask(), existing]);
    const runner = makeRunner();
    const idAllocator = makeIdAllocator(51);
    const runLogs = [];
    const orchestrator = makeOrchestrator({ store, git: makeGit(), runner, idAllocator, runLogs });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner);
    await runPromise;

    expect(idAllocator.allocate).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(2);
    expect((await store.get("T-0001")).depends_on).toEqual([existing.id]);

    const messages = runLogs[0].events.filter((e) => e.type === "escalation").map((e) => e.message);
    expect(messages.some((m) => m.includes(existing.id) && /open/i.test(m))).toBe(true);
  });

  it("picks the most recently created closed remediation card across a long history, not the first one found", async () => {
    const oldest = retiredRemediation({ id: "T-0040", status: "retired", body: "<!-- escalation-remediation-for: T-0001 -->\n\noldest" });
    const newest = retiredRemediation({ id: "T-0090", status: "done", body: "<!-- escalation-remediation-for: T-0001 -->\n\nnewest" });
    const store = makeStore([baseTask(), oldest, newest]);
    const runner = makeRunner();
    const idAllocator = makeIdAllocator(91);
    const runLogs = [];
    const orchestrator = makeOrchestrator({ store, git: makeGit(), runner, idAllocator, runLogs });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner);
    await runPromise;

    const allTasks = await store.list();
    const fresh = allTasks.find((t) => !["T-0001", oldest.id, newest.id].includes(t.id));
    expect(fresh).toBeTruthy();

    const messages = runLogs[0].events.filter((e) => e.type === "escalation").map((e) => e.message);
    expect(messages.some((m) => m.includes(newest.id))).toBe(true);
    expect(messages.some((m) => m.includes(oldest.id))).toBe(false);
  });

  it("creates a normal fresh remediation card when the prior remediation card was deleted outright (lookup returns nothing)", async () => {
    const store = makeStore([baseTask({ depends_on: ["T-0050"] })]);
    const runner = makeRunner();
    const idAllocator = makeIdAllocator(51);
    const orchestrator = makeOrchestrator({ store, git: makeGit(), runner, idAllocator });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner);
    await runPromise;

    expect(idAllocator.allocate).toHaveBeenCalledTimes(1);
    const original = await store.get("T-0001");
    const allTasks = await store.list();
    const fresh = allTasks.find((t) => t.id !== "T-0001");
    expect(fresh).toBeTruthy();
    expect(original.depends_on).toContain(fresh.id);
  });
});

describe("RunOrchestrator escalation -- degrades gracefully on failure", () => {
  it("leaves the card correctly blocked with its FAIL notes even when escalation itself fails (e.g. store.list unavailable)", async () => {
    const store = makeStoreWithoutList([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner);
    await runPromise;

    const finalTask = await store.get("T-0001");
    expect(finalTask.status).toBe("blocked");
    expect(finalTask.attempts).toBe(MAX_AUTO_RETRY_ATTEMPTS);
    const archived = (orchestrator.testVerdictArchives.get("T-0001") ?? []).map((e) => e.text).join("\n");
    expect(archived).toMatch(/auto-retry limit reached/i);
  });

  it("logs to the console when even the escalation-failure write itself fails, instead of swallowing it silently -- the actual reason this went unnoticed for weeks", async () => {
    const store = makeStoreWithoutList([baseTask()]);
    const git = makeGit();
    const runner = makeRunner();
    // Spy on BOTH levels: the assertion below is about these failures being console-VISIBLE
    // (as this test's own comment says), not about which level carries them. The escalation
    // path logs at error level so the full Error object -- and therefore the stack -- survives;
    // a bare `err.message` at warn level is what made T-0301 so slow to place.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwingRunLog = {
      events: [],
      async append(event) {
        if (event.type === "escalation") throw new Error("disk full");
        this.events.push(event);
      },
      close: vi.fn(async () => {})
    };
    const orchestrator = makeOrchestrator({
      store,
      git,
      runner,
      createRunLogFn: vi.fn(async () => throwingRunLog)
    });

    try {
      const runPromise = orchestrator.runCard("T-0001");
      await exhaustToBlocked(runner);
      await runPromise;

      // Two separate failures must both be console-visible: the original escalation failure
      // (store.list missing) and the follow-up failure to even record it (runLog.append throwing).
      const messages = [...warnSpy.mock.calls, ...errorSpy.mock.calls].map((args) =>
        args.map((a) => (a instanceof Error ? `${a.message} ${a.stack ?? ""}` : String(a))).join(" ")
      );
      expect(messages.some((m) => m.includes("T-0001") && m.includes("escalation failed"))).toBe(true);
      expect(messages.some((m) => m.includes("T-0001") && m.includes("disk full"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe("RunOrchestrator.runCard -- pick-up loop skips agent: dispatch cards", () => {
  it("refuses to run a card assigned to the dispatch sentinel, without spawning anything", async () => {
    const store = makeStore([baseTask({ agent: "dispatch", status: "ready" })]);
    const git = makeGit();
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git, runner });

    await expect(orchestrator.runCard("T-0001")).rejects.toThrow(/dispatch/i);
    expect(runner.start).not.toHaveBeenCalled();
    expect((await store.get("T-0001")).status).toBe("ready");
  });
});

describe("RunOrchestrator escalation -- routine rate_limit_event telemetry", () => {
  /** The shape the claude CLI emits on EVERY session, healthy or not. */
  function rateLimitEvent(info) {
    return { type: "rate_limit_event", rate_limit_info: info, session_id: "s-1" };
  }

  it("still escalates when every attempt carried routine allowed rate-limit telemetry", async () => {
    // Regression guard for the live T-0233 failure. The CLI emits a rate_limit_event on every
    // session, so serializing each event and substring-matching "rate_limit" suppressed
    // escalation for EVERY exhausted card. Here the retries are exhausted by a real blocker
    // while the telemetry stays healthy -- this must produce a report and a remediation card.
    const store = makeStore([baseTask()]);
    const runner = makeRunner();
    const idAllocator = makeIdAllocator();
    const orchestrator = makeOrchestrator({ store, git: makeGit(), runner, idAllocator });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner, {
      extraEventsForAttempt: () => [
        rateLimitEvent({ status: "allowed", rateLimitType: "five_hour", isUsingOverage: false }),
        rateLimitEvent({
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 0.97,
          surpassedThreshold: 0.9,
          overageStatus: "rejected",
          overageDisabledReason: "out_of_credits"
        })
      ]
    });
    await runPromise;

    const original = await store.get("T-0001");
    expect(original.status).toBe("blocked");
    expect(original.comments.find((c) => c.text.includes("Blocker report"))).toBeTruthy();

    const remediation = (await store.list()).find((t) => t.id !== "T-0001");
    expect(remediation).toBeTruthy();
    expect(remediation.status).toBe("ready");
    expect(remediation.body).toContain("<!-- escalation-remediation-for: T-0001 -->");
    expect(original.depends_on).toContain(remediation.id);
  });

  it("still suppresses when one attempt carried a genuine rejected rate-limit event", async () => {
    const store = makeStore([baseTask()]);
    const runner = makeRunner();
    const orchestrator = makeOrchestrator({ store, git: makeGit(), runner });

    const runPromise = orchestrator.runCard("T-0001");
    await exhaustToBlocked(runner, {
      extraEventsForAttempt: (n) =>
        n === 3
          ? [rateLimitEvent({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1787932800 })]
          : [rateLimitEvent({ status: "allowed", rateLimitType: "five_hour" })]
    });
    await runPromise;

    const original = await store.get("T-0001");
    expect(original.status).toBe("blocked");
    expect(original.comments).toEqual([]);
    expect(original.depends_on).toEqual([]);
    expect(await store.list()).toHaveLength(1);
  });
});
