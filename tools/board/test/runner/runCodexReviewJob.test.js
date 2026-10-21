import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runCodexReviewJob, reviewRunStateKey } from "../../scripts/runCodexReview.js";

const SHA = "a".repeat(40);
const WORKTREE_DIR = "/repo/worktrees/T-0460";

function makeFakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  return child;
}

function baseDeps(overrides = {}) {
  return {
    taskId: "T-0460",
    worktreeDir: WORKTREE_DIR,
    codexBin: "/usr/local/bin/codex",
    codexHome: "/home/dennieseth/.codex",
    acceptanceCriteriaVersion: "2026-10-21",
    gitHeadFn: vi.fn(() => SHA),
    createRunLogFn: vi.fn(async ({ taskId }) => ({
      runId: `${taskId}-2026-10-21T18-00-00-000Z`,
      path: "/tmp/fake-run.jsonl",
      append: vi.fn(async () => {}),
      close: vi.fn(async () => {})
    })),
    readRunStateFn: vi.fn(async () => null),
    isRunLiveFn: vi.fn(async () => false),
    writeRunStateFn: vi.fn(async () => {}),
    clearRunStateFn: vi.fn(async () => {}),
    publishCodexVerdictFn: vi.fn(async () => ({ status: "published", outcome: "PASS" })),
    writeFileFn: vi.fn(async () => {}),
    mkdirFn: vi.fn(async () => {}),
    now: vi.fn(() => 0),
    ...overrides
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("runCodexReviewJob -- the subject card being mid-run (precondition)", () => {
  it("refuses to start and publishes BLOCKED, never constructing a runner, when the subject's OWN implementation run is live", async () => {
    const createRunner = vi.fn();
    const subjectState = { pid: 555, updatedAt: "2026-10-21T18:00:00.000Z" };
    const isRunLiveFn = vi.fn(async ({ state }) => state === subjectState);
    const readRunStateFn = vi.fn(async ({ taskId }) => (taskId === "T-0460" ? subjectState : null));

    const result = await runCodexReviewJob(
      baseDeps({ createRunner, isRunLiveFn, readRunStateFn })
    );

    expect(result.refused).toBe("subject-mid-run");
    expect(createRunner).not.toHaveBeenCalled();
    expect(result.publishResult.status).toBe("published");
  });
});

describe("runCodexReviewJob -- duplicate-start refusal (the review job's OWN liveness, separate from the subject's)", () => {
  it("refuses a second invocation while a review of the same card is already in flight, without overwriting the in-flight review's runstate", async () => {
    const createRunner = vi.fn();
    const reviewState = { pid: 777, updatedAt: "2026-10-21T18:00:00.000Z" };
    const readRunStateFn = vi.fn(async ({ taskId }) => (taskId === reviewRunStateKey("T-0460") ? reviewState : null));
    const isRunLiveFn = vi.fn(async ({ state }) => state === reviewState);
    const writeRunStateFn = vi.fn(async () => {});

    const result = await runCodexReviewJob(
      baseDeps({ createRunner, readRunStateFn, isRunLiveFn, writeRunStateFn })
    );

    expect(result.refused).toBe("review-already-in-flight");
    expect(createRunner).not.toHaveBeenCalled();
    // The refusal itself never writes a review runstate -- nothing to overwrite the live one with.
    expect(writeRunStateFn).not.toHaveBeenCalled();
  });

  it("checks the review job's OWN key, never the subject's bare taskId -- so a live SUBJECT run and a live REVIEW run are distinguishable", async () => {
    const readRunStateFn = vi.fn(async ({ taskId }) => taskId);
    const child = makeFakeChild();
    const createRunner = vi.fn(() => ({
      start: vi.fn(async () => ({ child, spawnError: null, timedOut: false, budgetExceeded: false }))
    }));

    const jobPromise = runCodexReviewJob(baseDeps({ readRunStateFn, isRunLiveFn: vi.fn(async () => false), createRunner }));
    await settle();
    child.emit("exit", 0);
    await jobPromise;

    const taskIdsChecked = readRunStateFn.mock.calls.map((call) => call[0].taskId);
    expect(taskIdsChecked).toContain("T-0460");
    expect(taskIdsChecked).toContain(reviewRunStateKey("T-0460"));
    expect(taskIdsChecked[0]).not.toBe(taskIdsChecked[1]);
  });
});

describe("runCodexReviewJob -- the governed lifecycle it now makes", () => {
  it("writes this review job's OWN runstate (never the subject's bare taskId), then clears only that key when done", async () => {
    const writeRunStateFn = vi.fn(async () => {});
    const clearRunStateFn = vi.fn(async () => {});
    const child = makeFakeChild();
    const createRunner = vi.fn(() => ({
      start: vi.fn(async () => ({ child, spawnError: null, timedOut: false, budgetExceeded: false }))
    }));

    const jobPromise = runCodexReviewJob(baseDeps({ writeRunStateFn, clearRunStateFn, createRunner }));
    await settle();
    child.emit("exit", 0);
    await jobPromise;

    expect(writeRunStateFn).toHaveBeenCalledTimes(1);
    expect(writeRunStateFn.mock.calls[0][0].taskId).toBe(reviewRunStateKey("T-0460"));
    expect(clearRunStateFn).toHaveBeenCalledTimes(1);
    expect(clearRunStateFn.mock.calls[0][0].taskId).toBe(reviewRunStateKey("T-0460"));
  });

  it("streams NDJSON events into the run log durably as they arrive, not only after the child exits", async () => {
    const appended = [];
    const createRunLogFn = vi.fn(async ({ taskId }) => ({
      runId: `${taskId}-2026-10-21T18-00-00-000Z`,
      path: "/tmp/fake-run.jsonl",
      append: vi.fn(async (event) => {
        appended.push(event);
      }),
      close: vi.fn(async () => {})
    }));
    const child = makeFakeChild();
    const createRunner = vi.fn(() => ({
      start: vi.fn(async () => ({ child, spawnError: null, timedOut: false, budgetExceeded: false }))
    }));
    const publishCodexVerdictFn = vi.fn(async () => ({ status: "published", outcome: "PASS" }));

    const jobPromise = runCodexReviewJob(baseDeps({ createRunLogFn, createRunner, publishCodexVerdictFn }));
    await settle();

    // Emitted BEFORE the exit event -- proves the append happens as data streams, not in a
    // post-hoc loop over the fully-buffered stdout after the child has already exited.
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "thread.started", thread_id: "t1" })}\n`));
    await settle();
    expect(appended).toEqual([{ type: "thread.started", thread_id: "t1" }]);

    child.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: JSON.stringify({ job: { jobId: "x", ticketId: "T-0460", sprintId: "spike" }, reviewedSha: SHA, acceptanceCriteriaVersion: "2026-10-21", outcome: "PASS", findings: [], checksPerformed: [], limitations: [] }) } })}\n`
      )
    );
    child.emit("exit", 0);

    const result = await jobPromise;
    expect(appended.length).toBe(2);
    expect(result.exitCode).toBe(0);
    expect(publishCodexVerdictFn).toHaveBeenCalledTimes(1);
  });

  it("inspects run.budgetExceeded -- a budget kill surfaces as BLOCKED/budget-exceeded, not a generic non-zero exit", async () => {
    const child = makeFakeChild();
    const createRunner = vi.fn(() => ({
      start: vi.fn(async () => ({ child, spawnError: null, timedOut: false, budgetExceeded: true }))
    }));
    const publishCodexVerdictFn = vi.fn(async () => ({ status: "published", outcome: "BLOCKED" }));

    const jobPromise = runCodexReviewJob(baseDeps({ createRunner, publishCodexVerdictFn }));
    await settle();
    child.emit("exit", null);

    const result = await jobPromise;
    expect(result.budgetExceeded).toBe(true);
    expect(publishCodexVerdictFn).toHaveBeenCalledTimes(1);
    const call = publishCodexVerdictFn.mock.calls[0][0];
    expect(call.runResult).toEqual({ kind: "process-failure", reason: "budget-exceeded", detail: { maxTotalTokens: expect.any(Number) } });
  });

  it("a timeout surfaces as BLOCKED/timeout", async () => {
    const child = makeFakeChild();
    const createRunner = vi.fn(() => ({
      start: vi.fn(async () => ({ child, spawnError: null, timedOut: true, budgetExceeded: false }))
    }));
    const publishCodexVerdictFn = vi.fn(async () => ({ status: "published", outcome: "BLOCKED" }));

    const jobPromise = runCodexReviewJob(baseDeps({ createRunner, publishCodexVerdictFn }));
    await settle();
    child.emit("exit", null);

    await jobPromise;
    const [call] = publishCodexVerdictFn.mock.calls[0];
    expect(call.runResult.reason).toBe("timeout");
  });
});
