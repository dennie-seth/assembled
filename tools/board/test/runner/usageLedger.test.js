import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  summarizeUsageFromEvents,
  usageLedgerEntryPath,
  recordAttemptUsage,
  readAttemptUsage,
  listCardUsageEntries,
  attemptTotal,
  cardCycleTotal,
  executionTotal,
  ensureExecutionId,
  clearExecutionId,
  drainPendingUsageWrites
} from "../../src/runner/usageLedger.js";

let assistantMessageCounter = 0;

/**
 * A real assistant turn always carries a message id and (per the T-0367 fix-round audit of six
 * live logs) a session id -- both default here to a fresh, distinct value per call so existing
 * tests summing multiple `assistantTurn()` calls keep behaving exactly as before (each is a
 * genuinely distinct message). Tests exercising the repeated-message-snapshot bug pass the same
 * `id`/`sessionId` explicitly.
 */
function assistantTurn({
  model = "claude-sonnet-5",
  input = 0,
  output = 0,
  cacheCreate = 0,
  cacheRead = 0,
  id,
  sessionId = "session-1"
} = {}) {
  assistantMessageCounter += 1;
  return {
    type: "assistant",
    session_id: sessionId,
    message: {
      id: id ?? `msg-${assistantMessageCounter}`,
      role: "assistant",
      model,
      content: [{ type: "text", text: "working" }],
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead
      }
    }
  };
}

/** A real completed run's terminal shape: the result event's usage is the SESSION cumulative. */
function resultEvent({
  isError = false,
  input = 0,
  output = 0,
  cacheCreate = 0,
  cacheRead = 0,
  costUsd = 0,
  terminalReason,
  apiErrorStatus,
  result = "done"
} = {}) {
  const event = {
    type: "result",
    is_error: isError,
    result,
    total_cost_usd: costUsd,
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_creation_input_tokens: cacheCreate,
      cache_read_input_tokens: cacheRead
    }
  };
  if (terminalReason) event.terminal_reason = terminalReason;
  if (apiErrorStatus) event.api_error_status = apiErrorStatus;
  return event;
}

/** Live shape from a genuine 429 session-limit stop (card evidence, T-0367). */
function quotaStopResultEvent() {
  return resultEvent({
    isError: true,
    terminalReason: "api_error",
    apiErrorStatus: 429,
    result: "You've hit your session limit · resets 6pm (Europe/Budapest)",
    input: 12000,
    output: 3400,
    cacheCreate: 500,
    cacheRead: 8000,
    costUsd: 1.42
  });
}

describe("summarizeUsageFromEvents", () => {
  it("returns all-zero, source none, for an empty event list", () => {
    const summary = summarizeUsageFromEvents([]);
    expect(summary.tokens).toEqual({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });
    expect(summary.costUsd).toBe(0);
    expect(summary.models).toEqual([]);
    expect(summary.usageSource).toBe("none");
  });

  it("uses the result event's cumulative usage as authoritative, not the per-message sum", () => {
    // The spec's core warning: never add per-message usage to a cumulative final result. Each
    // assistant turn's usage is small; the result event already carries the whole session's total.
    const events = [
      assistantTurn({ input: 100, output: 50 }),
      assistantTurn({ input: 120, output: 60 }),
      resultEvent({ input: 5000, output: 1200, cacheCreate: 200, cacheRead: 900, costUsd: 0.87 })
    ];

    const summary = summarizeUsageFromEvents(events);

    expect(summary.tokens).toEqual({ input: 5000, output: 1200, cacheCreate: 200, cacheRead: 900 });
    expect(summary.costUsd).toBe(0.87);
    expect(summary.usageSource).toBe("result");
  });

  it("falls back to the per-message sum as a lower bound when no result event exists", () => {
    // Simulates a cancel/crash/phase-timeout: the run was cut off mid-stream, no result event
    // ever arrived, so the only evidence of usage is what each assistant turn reported.
    const events = [
      assistantTurn({ input: 100, output: 50, cacheCreate: 10, cacheRead: 5 }),
      assistantTurn({ input: 120, output: 60, cacheCreate: 0, cacheRead: 20 })
    ];

    const summary = summarizeUsageFromEvents(events);

    expect(summary.tokens).toEqual({ input: 220, output: 110, cacheCreate: 10, cacheRead: 25 });
    expect(summary.usageSource).toBe("incremental");
    // a lower bound, not zero
    expect(summary.tokens.input).toBeGreaterThan(0);
  });

  it("captures the model(s) seen across assistant turns", () => {
    const events = [assistantTurn({ model: "claude-sonnet-5" }), assistantTurn({ model: "claude-sonnet-5" })];
    const summary = summarizeUsageFromEvents(events);
    expect(summary.models).toEqual(["claude-sonnet-5"]);
  });

  it("captures the quota-stop terminal shape: terminal_reason, api_error_status, result text", () => {
    const events = [assistantTurn({ input: 10, output: 5 }), quotaStopResultEvent()];
    const summary = summarizeUsageFromEvents(events);

    expect(summary.usageSource).toBe("result");
    expect(summary.terminalReason).toBe("api_error");
    expect(summary.apiErrorStatus).toBe(429);
    expect(summary.resultText).toMatch(/session limit/);
    expect(summary.tokens.input).toBe(12000);
  });

  it("ignores malformed events rather than throwing", () => {
    expect(() => summarizeUsageFromEvents([null, undefined, 42, "oops", {}])).not.toThrow();
  });

  it("is not an array-safe function only by accident -- non-array input yields the zero summary", () => {
    const summary = summarizeUsageFromEvents(null);
    expect(summary.usageSource).toBe("none");
  });
});

describe("summarizeUsageFromEvents -- message-level dedup (Codex review 2026-09-12, P1)", () => {
  it("does not sum repeated snapshots of the same assistant message -- input 10, not 20", () => {
    const events = [
      assistantTurn({ id: "msg-shared", sessionId: "sess-1", input: 10 }),
      assistantTurn({ id: "msg-shared", sessionId: "sess-1", input: 10 })
    ];
    const summary = summarizeUsageFromEvents(events);
    expect(summary.tokens.input).toBe(10);
  });

  it("keys dedup by session + message id together -- the same message id under a different session is not deduped", () => {
    const events = [
      assistantTurn({ id: "msg-1", sessionId: "sess-A", input: 10 }),
      assistantTurn({ id: "msg-1", sessionId: "sess-B", input: 10 })
    ];
    const summary = summarizeUsageFromEvents(events);
    expect(summary.tokens.input).toBe(20);
  });

  it("real repeated-message stream shape: the same id repeats verbatim 3x, sums once per id, and a truncation before any result event still reads as a lower bound", () => {
    // Shape from the T-0367 fix-round audit of 381_event_audit.log: a message id repeats with
    // IDENTICAL usage counters across occurrences (a snapshot, not a delta) -- and no `result`
    // event ever arrives (the run was cut off mid-stream).
    const events = [
      assistantTurn({ id: "msg-1", sessionId: "s", input: 2, output: 1, cacheCreate: 27666, cacheRead: 32154 }),
      assistantTurn({ id: "msg-1", sessionId: "s", input: 2, output: 1, cacheCreate: 27666, cacheRead: 32154 }),
      assistantTurn({ id: "msg-1", sessionId: "s", input: 2, output: 1, cacheCreate: 27666, cacheRead: 32154 }),
      assistantTurn({ id: "msg-2", sessionId: "s", input: 5, output: 3 })
    ];
    const summary = summarizeUsageFromEvents(events);
    expect(summary.usageSource).toBe("incremental");
    expect(summary.tokens).toEqual({ input: 7, output: 4, cacheCreate: 27666, cacheRead: 32154 });
  });

  it("a final result event stays authoritative within its session even over a repeated-message stream", () => {
    const events = [
      assistantTurn({ id: "msg-1", sessionId: "s", input: 2, cacheCreate: 27666 }),
      assistantTurn({ id: "msg-1", sessionId: "s", input: 2, cacheCreate: 27666 }),
      resultEvent({ input: 90000, output: 12000, costUsd: 3.5 })
    ];
    const summary = summarizeUsageFromEvents(events);
    expect(summary.usageSource).toBe("result");
    expect(summary.tokens.input).toBe(90000);
    expect(summary.usageIncomplete).toBe(false);
  });

  it("reports a missing message id as incomplete, never as complete zero-cost data", () => {
    const events = [{ type: "assistant", message: { role: "assistant", model: "claude-sonnet-5", content: [], usage: { input_tokens: 10 } } }];
    const summary = summarizeUsageFromEvents(events);
    expect(summary.usageIncomplete).toBe(true);
    expect(summary.tokens.input).toBe(0);
  });

  it("reports missing usage on an otherwise-identified message as incomplete, never as complete zero-cost data", () => {
    const events = [{ type: "assistant", session_id: "s", message: { id: "msg-1", role: "assistant", model: "claude-sonnet-5", content: [] } }];
    const summary = summarizeUsageFromEvents(events);
    expect(summary.usageIncomplete).toBe(true);
    expect(summary.tokens.input).toBe(0);
  });

  it("a fully-formed incremental stream is not flagged incomplete", () => {
    const events = [assistantTurn({ id: "msg-1", input: 10 })];
    const summary = summarizeUsageFromEvents(events);
    expect(summary.usageIncomplete).toBe(false);
  });
});

describe("recordAttemptUsage / readAttemptUsage -- idempotent ledger", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-usage-ledger-"));
  });

  afterEach(async () => {
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  const key = { cardId: "T-0367", executionId: "exec-1", attempt: 1, phase: "implementer", retry: 0 };

  it("writes one JSON sidecar per (card, execution, attempt, phase, retry) key", async () => {
    const events = [assistantTurn({ input: 10, output: 5 }), resultEvent({ input: 400, output: 100, costUsd: 0.02 })];
    await recordAttemptUsage({ runsDir, ...key, events, outcome: "success", complete: true });

    const filePath = usageLedgerEntryPath(runsDir, key);
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(raw.cardId).toBe("T-0367");
    expect(raw.outcome).toBe("success");
    expect(raw.complete).toBe(true);
    expect(raw.tokens.input).toBe(400);
  });

  it("replaying the same events twice does not double-count", async () => {
    const events = [resultEvent({ input: 400, output: 100, cacheCreate: 20, cacheRead: 60, costUsd: 0.02 })];

    await recordAttemptUsage({ runsDir, ...key, events, outcome: "success", complete: true });
    await recordAttemptUsage({ runsDir, ...key, events, outcome: "success", complete: true });

    const entry = await readAttemptUsage({ runsDir, ...key });
    expect(entry.tokens).toEqual({ input: 400, output: 100, cacheCreate: 20, cacheRead: 60 });
    expect(entry.costUsd).toBe(0.02);
  });

  it("recording again with a longer (growing) event list overwrites rather than accumulates", async () => {
    const firstPass = [assistantTurn({ input: 50, output: 20 })];
    const secondPass = [...firstPass, resultEvent({ input: 400, output: 100, costUsd: 0.02 })];

    await recordAttemptUsage({ runsDir, ...key, events: firstPass, outcome: "crashed", complete: false });
    await recordAttemptUsage({ runsDir, ...key, events: secondPass, outcome: "success", complete: true });

    const entry = await readAttemptUsage({ runsDir, ...key });
    // must reflect the result event's cumulative total, not firstPass + result
    expect(entry.tokens.input).toBe(400);
    expect(entry.outcome).toBe("success");
    expect(entry.complete).toBe(true);
  });

  it("readAttemptUsage returns null for a key that was never recorded", async () => {
    const entry = await readAttemptUsage({ runsDir, cardId: "T-9999", executionId: "exec-1", attempt: 1, phase: "implementer", retry: 0 });
    expect(entry).toBeNull();
  });

  it("keeps an interrupted attempt's partial usage as a lower bound, not zero", async () => {
    const events = [assistantTurn({ input: 300, output: 80 })];
    await recordAttemptUsage({ runsDir, ...key, events, outcome: "phase_timeout", complete: false });

    const entry = await readAttemptUsage({ runsDir, ...key });
    expect(entry.complete).toBe(false);
    expect(entry.outcome).toBe("phase_timeout");
    expect(entry.usageSource).toBe("incremental");
    expect(entry.tokens.input).toBe(300);
  });

  it("records every termination case with outcome and completeness", async () => {
    const cases = [
      { outcome: "success", complete: true, events: [resultEvent({ input: 10, output: 5 })] },
      { outcome: "quota_stop", complete: true, events: [quotaStopResultEvent()] },
      { outcome: "reviewer_fail", complete: true, events: [resultEvent({ input: 10, output: 5, result: "reviewer verdict: FAIL" })] },
      { outcome: "cancelled", complete: false, events: [assistantTurn({ input: 10, output: 5 })] },
      { outcome: "crashed", complete: false, events: [assistantTurn({ input: 10, output: 5 })] },
      { outcome: "phase_timeout", complete: false, events: [assistantTurn({ input: 10, output: 5 })] }
    ];

    for (let i = 0; i < cases.length; i += 1) {
      const c = cases[i];
      await recordAttemptUsage({
        runsDir,
        cardId: "T-0367",
        executionId: "exec-1",
        attempt: 1,
        phase: "implementer",
        retry: i,
        events: c.events,
        outcome: c.outcome,
        complete: c.complete
      });
    }

    for (let i = 0; i < cases.length; i += 1) {
      const entry = await readAttemptUsage({ runsDir, cardId: "T-0367", executionId: "exec-1", attempt: 1, phase: "implementer", retry: i });
      expect(entry.outcome).toBe(cases[i].outcome);
      expect(entry.complete).toBe(cases[i].complete);
    }
  });
});

describe("listCardUsageEntries / attemptTotal / cardCycleTotal", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-usage-ledger-totals-"));
  });

  afterEach(async () => {
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  it("sums attempt totals across phases/retries within one attempt", async () => {
    await recordAttemptUsage({
      runsDir,
      cardId: "T-1000",
      executionId: "exec-1",
      attempt: 1,
      phase: "implementer",
      retry: 0,
      events: [resultEvent({ input: 100, output: 20, costUsd: 0.01 })],
      outcome: "success",
      complete: true
    });
    await recordAttemptUsage({
      runsDir,
      cardId: "T-1000",
      executionId: "exec-1",
      attempt: 1,
      phase: "reviewer",
      retry: 0,
      events: [resultEvent({ input: 50, output: 10, costUsd: 0.005 })],
      outcome: "success",
      complete: true
    });
    // a second attempt (retry after FAIL) must not bleed into attempt 1's total
    await recordAttemptUsage({
      runsDir,
      cardId: "T-1000",
      executionId: "exec-1",
      attempt: 2,
      phase: "implementer",
      retry: 0,
      events: [resultEvent({ input: 900, output: 300, costUsd: 0.09 })],
      outcome: "success",
      complete: true
    });

    const entries = await listCardUsageEntries({ runsDir, cardId: "T-1000" });

    const attempt1 = attemptTotal(entries, 1);
    expect(attempt1.tokens.input).toBe(150);
    expect(attempt1.costUsd).toBeCloseTo(0.015, 6);

    const attempt2 = attemptTotal(entries, 2);
    expect(attempt2.tokens.input).toBe(900);
  });

  it("card-cycle (lifetime) total sums every attempt recorded for the card", async () => {
    await recordAttemptUsage({
      runsDir,
      cardId: "T-2000",
      executionId: "exec-1",
      attempt: 1,
      phase: "implementer",
      retry: 0,
      events: [resultEvent({ input: 100, output: 20, costUsd: 0.01 })],
      outcome: "reviewer_fail",
      complete: true
    });
    await recordAttemptUsage({
      runsDir,
      cardId: "T-2000",
      executionId: "exec-1",
      attempt: 2,
      phase: "implementer",
      retry: 0,
      events: [resultEvent({ input: 200, output: 40, costUsd: 0.02 })],
      outcome: "success",
      complete: true
    });

    const entries = await listCardUsageEntries({ runsDir, cardId: "T-2000" });
    const total = cardCycleTotal(entries);

    expect(total.tokens.input).toBe(300);
    expect(total.costUsd).toBeCloseTo(0.03, 6);
  });

  it("listCardUsageEntries does not pick up a different card's entries", async () => {
    await recordAttemptUsage({
      runsDir,
      cardId: "T-3001",
      executionId: "exec-1",
      attempt: 1,
      phase: "implementer",
      retry: 0,
      events: [resultEvent({ input: 5, output: 1 })],
      outcome: "success",
      complete: true
    });
    await recordAttemptUsage({
      runsDir,
      cardId: "T-3002",
      executionId: "exec-1",
      attempt: 1,
      phase: "implementer",
      retry: 0,
      events: [resultEvent({ input: 999, output: 999 })],
      outcome: "success",
      complete: true
    });

    const entries = await listCardUsageEntries({ runsDir, cardId: "T-3001" });
    expect(entries).toHaveLength(1);
    expect(entries[0].cardId).toBe("T-3001");
  });

  it("returns an empty list, and zero totals, when the card has no recorded usage", async () => {
    const entries = await listCardUsageEntries({ runsDir, cardId: "T-9999" });
    expect(entries).toEqual([]);
    expect(cardCycleTotal(entries)).toEqual({
      tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
      costUsd: 0
    });
  });
});

describe("execution identity (Codex review 2026-09-12, P1)", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-usage-ledger-execution-"));
  });

  afterEach(async () => {
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  it("two separate launches of the same card, both attempt 1, keep separate execution totals that still sum to a correct lifetime total", async () => {
    // Codex's exact reproduction: a rerun used to restart at attempt 1 and overwrite the
    // previous launch's attempt-1 file, so the card total came out to 25, not 125.
    await recordAttemptUsage({
      runsDir,
      cardId: "T-REVIEW",
      executionId: "exec-A",
      attempt: 1,
      phase: "implementer",
      retry: 0,
      events: [assistantTurn({ id: "msg-1", input: 100 })],
      outcome: "quota_stop",
      complete: false
    });
    await recordAttemptUsage({
      runsDir,
      cardId: "T-REVIEW",
      executionId: "exec-B",
      attempt: 1,
      phase: "implementer",
      retry: 0,
      events: [assistantTurn({ id: "msg-1", input: 25 })],
      outcome: "success",
      complete: true
    });

    const entries = await listCardUsageEntries({ runsDir, cardId: "T-REVIEW" });
    expect(cardCycleTotal(entries).tokens.input).toBe(125);
    expect(executionTotal(entries, "exec-A").tokens.input).toBe(100);
    expect(executionTotal(entries, "exec-B").tokens.input).toBe(25);
  });

  it("usageLedgerEntryPath produces distinct paths for distinct executions of the same (card, attempt, phase, retry)", () => {
    const a = usageLedgerEntryPath(runsDir, { cardId: "T-1", executionId: "exec-A", attempt: 1, phase: "implementer", retry: 0 });
    const b = usageLedgerEntryPath(runsDir, { cardId: "T-1", executionId: "exec-B", attempt: 1, phase: "implementer", retry: 0 });
    expect(a).not.toBe(b);
  });

  describe("ensureExecutionId / clearExecutionId", () => {
    it("mints a fresh id when none is persisted yet", async () => {
      const id = await ensureExecutionId({ runsDir, cardId: "T-9001", generateIdFn: () => "generated-id" });
      expect(id).toBe("generated-id");
    });

    it("reuses the persisted id on a replay/recovery call instead of minting a new one", async () => {
      const first = await ensureExecutionId({ runsDir, cardId: "T-9002", generateIdFn: () => "first-id" });
      const second = await ensureExecutionId({ runsDir, cardId: "T-9002", generateIdFn: () => "second-id" });
      expect(first).toBe("first-id");
      expect(second).toBe("first-id");
    });

    it("clearExecutionId lets the next ensureExecutionId call mint a genuinely new id", async () => {
      const first = await ensureExecutionId({ runsDir, cardId: "T-9003", generateIdFn: () => "first-id" });
      await clearExecutionId({ runsDir, cardId: "T-9003" });
      const second = await ensureExecutionId({ runsDir, cardId: "T-9003", generateIdFn: () => "second-id" });
      expect(first).toBe("first-id");
      expect(second).toBe("second-id");
    });

    it("clearExecutionId is a no-op (never throws) when nothing was persisted", async () => {
      await expect(clearExecutionId({ runsDir, cardId: "T-9004" })).resolves.not.toThrow();
    });
  });
});

describe("write ordering and atomicity (Codex review 2026-09-12, P2)", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-usage-ledger-atomic-"));
  });

  afterEach(async () => {
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  const base = { runsDir, cardId: "T-REVIEW", executionId: "exec-1", attempt: 1, phase: "implementer", retry: 0 };

  it("a delayed earlier in-progress write never overwrites a later terminal write that already committed", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });

    const old = recordAttemptUsage({
      ...base,
      runsDir,
      events: [assistantTurn({ id: "msg-1", input: 10 })],
      outcome: "in_progress",
      complete: false,
      writeFileFn: async (...args) => {
        started();
        await gate;
        return fs.writeFile(...args);
      }
    });
    await ready;

    await recordAttemptUsage({
      ...base,
      runsDir,
      events: [assistantTurn({ id: "msg-1", input: 100 })],
      outcome: "success",
      complete: true
    });

    release();
    await old;

    const last = await readAttemptUsage({ ...base, runsDir });
    expect(last.tokens.input).toBe(100);
    expect(last.outcome).toBe("success");
    expect(last.complete).toBe(true);
  });

  it("publishes via a temp file then an atomic rename -- a reader never sees a half-written file", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });

    await recordAttemptUsage({
      ...base,
      runsDir,
      events: [assistantTurn({ id: "msg-1", input: 1 })],
      outcome: "in_progress",
      complete: false
    });

    const write = recordAttemptUsage({
      ...base,
      runsDir,
      events: [assistantTurn({ id: "msg-1", input: 2 })],
      outcome: "success",
      complete: true,
      writeFileFn: async (...args) => {
        const result = await fs.writeFile(...args);
        started();
        await gate;
        return result;
      }
    });
    await ready;

    // The new content has been fully written to its OWN temp file but not yet renamed into
    // place -- a concurrent reader of the real destination path must see the complete OLD
    // file, never a parse error from a half-renamed/half-written destination, and never the
    // new content before the rename that publishes it.
    const duringWrite = await readAttemptUsage({ ...base, runsDir });
    expect(duringWrite).not.toBeNull();
    expect(duringWrite.tokens.input).toBe(1);

    release();
    await write;

    const after = await readAttemptUsage({ ...base, runsDir });
    expect(after.tokens.input).toBe(2);
  });

  it("drainPendingUsageWrites waits for an in-flight write before resolving", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const write = recordAttemptUsage({
      ...base,
      runsDir,
      events: [assistantTurn({ id: "msg-1", input: 5 })],
      outcome: "success",
      complete: true,
      writeFileFn: async (...args) => {
        await gate;
        return fs.writeFile(...args);
      }
    });

    let drained = false;
    const drain = drainPendingUsageWrites().then(() => {
      drained = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drained).toBe(false);

    release();
    await write;
    await drain;
    expect(drained).toBe(true);
  });

  it("a failed write rejects (for the caller to swallow) and never leaves a corrupt/partial ledger file behind", async () => {
    // recordAttemptUsage itself may reject -- it's the ORCHESTRATOR's job (_recordUsage's
    // try/catch) to make that failure never affect a run's own verdict. This test just pins
    // that a failed write never leaves a corrupt/partial file behind.
    await expect(
      recordAttemptUsage({
        ...base,
        runsDir,
        events: [assistantTurn({ id: "msg-1", input: 1 })],
        outcome: "success",
        complete: true,
        writeFileFn: async () => {
          throw new Error("disk full");
        }
      })
    ).rejects.toThrow("disk full");

    const entry = await readAttemptUsage({ ...base, runsDir });
    expect(entry).toBeNull();
  });
});
