import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runCodexReviewJob,
  reviewRunStateKey,
  claimReviewSlot,
  releaseOwnedReviewSlot,
  REVIEW_SLOT_EXECUTION_ID,
  REVIEW_SLOT_INVOCATION_ID
} from "../../scripts/runCodexReview.js";
import { reservationLeasePath } from "../../src/runner/launchReservation.js";
import { rmTemp } from "../helpers/rmTemp.js";

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
    claimReviewSlotFn: vi.fn(async () => ({ claimed: true, executionId: REVIEW_SLOT_EXECUTION_ID, invocationId: REVIEW_SLOT_INVOCATION_ID })),
    releaseReviewSlotFn: vi.fn(async () => {}),
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

describe("runCodexReviewJob -- duplicate-start refusal, taken ATOMICALLY before any child is spawned (FIX ROUND 2, human comment (b))", () => {
  it("refuses a second invocation while a review of the same card is already in flight, never constructing a runner, when claimReviewSlotFn refuses", async () => {
    const createRunner = vi.fn();
    const claimReviewSlotFn = vi.fn(async () => ({ claimed: false, reason: "review-already-in-flight", existing: { owner: { pid: 777 } } }));
    const writeRunStateFn = vi.fn(async () => {});

    const result = await runCodexReviewJob(
      baseDeps({ createRunner, claimReviewSlotFn, writeRunStateFn })
    );

    expect(result.refused).toBe("review-already-in-flight");
    expect(createRunner).not.toHaveBeenCalled();
    // The refusal itself never writes a review runstate -- nothing to overwrite the live one with.
    expect(writeRunStateFn).not.toHaveBeenCalled();
  });

  it("claims the review job's OWN reservation key (reviewRunStateKey), never the subject's bare taskId -- so a live SUBJECT run and a live REVIEW run are distinguishable", async () => {
    const claimReviewSlotFn = vi.fn(async () => ({ claimed: true, executionId: REVIEW_SLOT_EXECUTION_ID, invocationId: REVIEW_SLOT_INVOCATION_ID }));
    const child = makeFakeChild();
    const createRunner = vi.fn(() => ({
      start: vi.fn(async () => ({ child, spawnError: null, timedOut: false, budgetExceeded: false }))
    }));

    const jobPromise = runCodexReviewJob(baseDeps({ claimReviewSlotFn, createRunner }));
    await settle();
    child.emit("exit", 0);
    await jobPromise;

    expect(claimReviewSlotFn).toHaveBeenCalledTimes(1);
    const claimArgs = claimReviewSlotFn.mock.calls[0][0];
    expect(claimArgs.cardId).toBe(reviewRunStateKey("T-0460"));
    expect(claimArgs.cardId).not.toBe("T-0460");
  });

  it("claims the slot BEFORE constructing a runner or calling start() -- the claim is taken first, not the read-then-write check it replaces", async () => {
    const order = [];
    const claimReviewSlotFn = vi.fn(async () => {
      order.push("claim");
      return { claimed: true, executionId: REVIEW_SLOT_EXECUTION_ID, invocationId: REVIEW_SLOT_INVOCATION_ID };
    });
    const child = makeFakeChild();
    const createRunner = vi.fn(() => {
      order.push("createRunner");
      return {
        start: vi.fn(async () => {
          order.push("start");
          return { child, spawnError: null, timedOut: false, budgetExceeded: false };
        })
      };
    });

    const jobPromise = runCodexReviewJob(baseDeps({ claimReviewSlotFn, createRunner }));
    await settle();
    child.emit("exit", 0);
    await jobPromise;

    expect(order).toEqual(["claim", "createRunner", "start"]);
  });

  it("releases the claimed slot once the review's own span ends (happy path)", async () => {
    const releaseReviewSlotFn = vi.fn(async () => {});
    const child = makeFakeChild();
    const createRunner = vi.fn(() => ({
      start: vi.fn(async () => ({ child, spawnError: null, timedOut: false, budgetExceeded: false }))
    }));

    const jobPromise = runCodexReviewJob(baseDeps({ releaseReviewSlotFn, createRunner }));
    await settle();
    child.emit("exit", 0);
    await jobPromise;

    expect(releaseReviewSlotFn).toHaveBeenCalledTimes(1);
    const releaseArgs = releaseReviewSlotFn.mock.calls[0][0];
    expect(releaseArgs.cardId).toBe(reviewRunStateKey("T-0460"));
    expect(releaseArgs.executionId).toBe(REVIEW_SLOT_EXECUTION_ID);
    expect(releaseArgs.invocationId).toBe(REVIEW_SLOT_INVOCATION_ID);
  });

  it("releases the claimed slot when runner.start() itself throws, rather than stranding the card forever behind an un-released claim", async () => {
    const releaseReviewSlotFn = vi.fn(async () => {});
    const startError = new Error("spawn EMFILE");
    const createRunner = vi.fn(() => ({
      start: vi.fn(async () => {
        throw startError;
      })
    }));

    await expect(runCodexReviewJob(baseDeps({ releaseReviewSlotFn, createRunner }))).rejects.toThrow(startError);

    expect(releaseReviewSlotFn).toHaveBeenCalledTimes(1);
  });
});

describe("claimReviewSlot / releaseOwnedReviewSlot -- launchReservation.js's own atomic lifecycle, not a read-then-write check", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-review-slot-test-"));
  });

  afterEach(async () => {
    await rmTemp(runsDir);
  });

  it("two simultaneous claims for the same cardId: exactly one wins, the other is refused as already in flight", async () => {
    const cardId = reviewRunStateKey("T-0460");
    const [first, second] = await Promise.all([
      claimReviewSlot({ runsDir, cardId, owner: { pid: process.pid, jobId: "job-a" } }),
      claimReviewSlot({ runsDir, cardId, owner: { pid: process.pid, jobId: "job-b" } })
    ]);

    const claimedCount = [first, second].filter((r) => r.claimed).length;
    expect(claimedCount).toBe(1);
    const refused = [first, second].find((r) => !r.claimed);
    expect(refused.reason).toBe("review-already-in-flight");
  });

  it("a prior review's RELEASED lease does not block a later review of the same card", async () => {
    const cardId = reviewRunStateKey("T-0460");
    const owner1 = { pid: process.pid, jobId: "job-a" };
    const first = await claimReviewSlot({ runsDir, cardId, owner: owner1 });
    expect(first.claimed).toBe(true);
    await releaseOwnedReviewSlot({ runsDir, cardId, executionId: first.executionId, invocationId: first.invocationId, owner: owner1, outcome: { status: "completed" } });

    const owner2 = { pid: process.pid, jobId: "job-b" };
    const second = await claimReviewSlot({ runsDir, cardId, owner: owner2 });
    expect(second.claimed).toBe(true);
  });

  it("a claim recorded under a pid that is no longer alive is reclaimable (process-crash recovery, not merely a clean release)", async () => {
    const cardId = reviewRunStateKey("T-0460");
    const deadOwner = { pid: 999999, jobId: "job-dead" };
    const first = await claimReviewSlot({ runsDir, cardId, owner: deadOwner });
    expect(first.claimed).toBe(true);

    const second = await claimReviewSlot({
      runsDir,
      cardId,
      owner: { pid: process.pid, jobId: "job-recovering" },
      isPidAliveFn: (pid) => pid !== 999999
    });
    expect(second.claimed).toBe(true);
  });

  it("a claim recorded under a pid that IS still alive is not reclaimable -- a genuinely concurrent review is refused, not raced", async () => {
    const cardId = reviewRunStateKey("T-0460");
    const liveOwner = { pid: 123456, jobId: "job-live" };
    const first = await claimReviewSlot({ runsDir, cardId, owner: liveOwner, isPidAliveFn: () => true });
    expect(first.claimed).toBe(true);

    const second = await claimReviewSlot({ runsDir, cardId, owner: { pid: process.pid, jobId: "job-b" }, isPidAliveFn: (pid) => pid === 123456 });
    expect(second.claimed).toBe(false);
    expect(second.reason).toBe("review-already-in-flight");
  });

  it("releaseOwnedReviewSlot only releases a claim THIS owner (pid) actually holds -- a claim recorded under a different pid is left untouched and survives", async () => {
    const cardId = reviewRunStateKey("T-0460");
    const foreignOwner = { pid: 555555, jobId: "foreign-job" };
    const claim = await claimReviewSlot({ runsDir, cardId, owner: foreignOwner, isPidAliveFn: () => true });
    expect(claim.claimed).toBe(true);

    const result = await releaseOwnedReviewSlot({
      runsDir,
      cardId,
      executionId: claim.executionId,
      invocationId: claim.invocationId,
      owner: { pid: process.pid }, // a DIFFERENT pid than the one that actually holds the claim
      outcome: { status: "completed" }
    });

    expect(result).toBeNull();

    const leasePath = reservationLeasePath(runsDir, { cardId, executionId: claim.executionId, invocationId: claim.invocationId });
    const lease = JSON.parse(await fs.readFile(leasePath, "utf8"));
    expect(lease.released).toBe(false);
    expect(lease.owner.pid).toBe(555555);
  });
});

describe("runCodexReviewJob -- real concurrency: two simultaneous starts for the same card", () => {
  let worktreeDir;

  beforeEach(async () => {
    worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-review-concurrency-test-"));
  });

  afterEach(async () => {
    await rmTemp(worktreeDir);
  });

  it("exactly one child is spawned; the other refuses with a stated reason, using the REAL launchReservation.js atomic claim (not a mock)", async () => {
    const children = [];
    const createRunner = vi.fn(() => {
      const child = makeFakeChild({ pid: 4000 + children.length });
      children.push(child);
      return {
        start: vi.fn(async () => ({ child, spawnError: null, timedOut: false, budgetExceeded: false }))
      };
    });

    const deps = baseDeps({
      worktreeDir,
      createRunner,
      // Real claim/release lifecycle -- deliberately NOT overridden with the mocked defaults, so
      // the two calls below race on the genuine atomic `link()` in launchReservation.js. Exactly
      // one wins regardless of scheduling, so this test does not depend on any fixed timing
      // window between the two `runCodexReviewJob` calls below.
      claimReviewSlotFn: claimReviewSlot,
      releaseReviewSlotFn: releaseOwnedReviewSlot
    });

    const jobPromiseA = runCodexReviewJob(deps);
    const jobPromiseB = runCodexReviewJob(deps);

    // Poll for the winner's child to exist rather than a fixed-delay settle() -- under heavy
    // parallel-suite load the real fs-backed claim can legitimately take longer than any small
    // fixed delay, and a hardcoded wait would either emit "exit" too early (nothing created yet)
    // or needlessly slow every run down to cover a worst case.
    const deadline = Date.now() + 5000;
    while (children.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (const child of children) child.emit("exit", 0);

    const [resultA, resultB] = await Promise.all([jobPromiseA, jobPromiseB]);

    expect(createRunner).toHaveBeenCalledTimes(1);
    const refused = [resultA, resultB].find((r) => r.refused);
    const started = [resultA, resultB].find((r) => !r.refused);
    expect(refused.refused).toBe("review-already-in-flight");
    expect(started).toBeDefined();
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
