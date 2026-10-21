import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { publishCodexVerdict, deliveryMarkerPath } from "../../src/runner/codexVerdictPublisher.js";
import { rmTemp } from "../helpers/rmTemp.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ACV = "2026-10-21";

function dispatchedJob(overrides = {}) {
  return { jobId: "job-1", ticketId: "T-0460", sprintId: "sprint-7", dispatchedSha: SHA_A, acceptanceCriteriaVersion: ACV, ...overrides };
}

function validPayload(overrides = {}) {
  return {
    job: { jobId: "job-1", ticketId: "T-0460", sprintId: "sprint-7" },
    reviewedSha: SHA_A,
    acceptanceCriteriaVersion: ACV,
    outcome: "PASS",
    findings: [],
    checksPerformed: ["npx vitest run"],
    limitations: [],
    ...overrides
  };
}

/** An in-memory stand-in for verdictArchive's readVerdictEntries/appendVerdictEntry, keyed by taskId. The exactly-once delivery claim itself is real filesystem state under a real temp `tasksDir` (see beforeEach) -- that is the actual mechanism under test, not something to fake away. */
function makeFakeArchive() {
  const store = new Map();
  return {
    readEntriesFn: vi.fn(async (_tasksDir, taskId) => store.get(taskId) ?? []),
    appendEntryFn: vi.fn(async (_tasksDir, taskId, entry) => {
      const list = store.get(taskId) ?? [];
      list.push(entry);
      store.set(taskId, list);
    }),
    store
  };
}

let tasksDir;

beforeEach(async () => {
  tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-verdict-publisher-test-"));
});

afterEach(async () => {
  await rmTemp(tasksDir);
});

describe("publishCodexVerdict -- failed process or invalid result is BLOCKED, never PASS", () => {
  it("non-zero exit -> published as BLOCKED", async () => {
    const archive = makeFakeArchive();
    const result = await publishCodexVerdict({
      tasksDir,
      taskId: "T-0460",
      deliveryId: "d1",
      dispatchedJob: dispatchedJob(),
      runResult: { kind: "process-failure", reason: "non-zero-exit", detail: { exitCode: 1 } },
      currentHead: SHA_A,
      ...archive
    });
    expect(result.status).toBe("published");
    expect(result.outcome).toBe("BLOCKED");
    expect(result.entry.outcome).toBe("BLOCKED");
    expect(result.entry.heading).toContain("BLOCKED");
  });

  it("timeout -> published as BLOCKED", async () => {
    const archive = makeFakeArchive();
    const result = await publishCodexVerdict({
      tasksDir,
      taskId: "T-0460",
      deliveryId: "d1",
      dispatchedJob: dispatchedJob(),
      runResult: { kind: "process-failure", reason: "timeout", detail: { timeoutMs: 600000 } },
      currentHead: SHA_A,
      ...archive
    });
    expect(result.outcome).toBe("BLOCKED");
    expect(result.reason).toBe("timeout");
  });

  it("truncated/unparseable JSON output -> published as BLOCKED, never degrades to 'no findings'", async () => {
    const archive = makeFakeArchive();
    const result = await publishCodexVerdict({
      tasksDir,
      taskId: "T-0460",
      deliveryId: "d1",
      dispatchedJob: dispatchedJob(),
      runResult: { kind: "parse-failure", reason: "truncated-json", detail: "unexpected end of input" },
      currentHead: SHA_A,
      ...archive
    });
    expect(result.outcome).toBe("BLOCKED");
    expect(result.entry.text).not.toMatch(/no findings/i);
  });

  it("schema-invalid payload (missing required outcome field) -> published as BLOCKED, absent outcome is never read as success", async () => {
    const archive = makeFakeArchive();
    const payload = validPayload();
    delete payload.outcome;
    const result = await publishCodexVerdict({
      tasksDir,
      taskId: "T-0460",
      deliveryId: "d1",
      dispatchedJob: dispatchedJob(),
      runResult: { kind: "payload", payload },
      currentHead: SHA_A,
      ...archive
    });
    expect(result.status).toBe("published");
    expect(result.outcome).toBe("BLOCKED");
    expect(result.errors.some((e) => e.includes("outcome"))).toBe(true);
  });

  it("missing findings array entirely -> BLOCKED, not silently treated as zero findings", async () => {
    const archive = makeFakeArchive();
    const payload = validPayload();
    delete payload.findings;
    const result = await publishCodexVerdict({
      tasksDir,
      taskId: "T-0460",
      deliveryId: "d1",
      dispatchedJob: dispatchedJob(),
      runResult: { kind: "payload", payload },
      currentHead: SHA_A,
      ...archive
    });
    expect(result.outcome).toBe("BLOCKED");
  });
});

describe("publishCodexVerdict -- identity validated before publish", () => {
  it("rejects a result whose job identity doesn't match the dispatched job -- not published, not corrected", async () => {
    const archive = makeFakeArchive();
    const result = await publishCodexVerdict({
      tasksDir,
      taskId: "T-0460",
      deliveryId: "d1",
      dispatchedJob: dispatchedJob({ jobId: "job-1" }),
      runResult: { kind: "payload", payload: validPayload({ job: { jobId: "job-OTHER", ticketId: "T-0460", sprintId: "sprint-7" } }) },
      currentHead: SHA_A,
      ...archive
    });
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("identity-mismatch");
    expect(archive.appendEntryFn).not.toHaveBeenCalled();
  });

  it("rejects a result whose ticketId doesn't match -- describing a different job's card", async () => {
    const archive = makeFakeArchive();
    const result = await publishCodexVerdict({
      tasksDir,
      taskId: "T-0460",
      deliveryId: "d1",
      dispatchedJob: dispatchedJob(),
      runResult: { kind: "payload", payload: validPayload({ job: { jobId: "job-1", ticketId: "T-9999", sprintId: "sprint-7" } }) },
      currentHead: SHA_A,
      ...archive
    });
    expect(result.status).toBe("rejected");
    expect(archive.appendEntryFn).not.toHaveBeenCalled();
  });

  it("rejects a result whose reviewedSha doesn't match the dispatched sha", async () => {
    const archive = makeFakeArchive();
    const result = await publishCodexVerdict({
      tasksDir,
      taskId: "T-0460",
      deliveryId: "d1",
      dispatchedJob: dispatchedJob(),
      runResult: { kind: "payload", payload: validPayload({ reviewedSha: SHA_B }) },
      currentHead: SHA_A,
      ...archive
    });
    expect(result.status).toBe("rejected");
    expect(archive.appendEntryFn).not.toHaveBeenCalled();
  });

  // T-0460's own real review run (tasks/.verdicts/T-0460.spike-evidence.json, job
  // T-0460-2026-10-21T12-19-45-975Z) found this gap live: a schema-valid payload naming the
  // right jobId/ticketId/reviewedSha but the WRONG sprintId was published as PASS instead of
  // being rejected, because the identity check never compared job.sprintId at all.
  it("rejects a result whose sprintId doesn't match -- not just jobId/ticketId/reviewedSha", async () => {
    const archive = makeFakeArchive();
    const result = await publishCodexVerdict({
      tasksDir,
      taskId: "T-0460",
      deliveryId: "d1",
      dispatchedJob: dispatchedJob({ sprintId: "sprint-7" }),
      runResult: {
        kind: "payload",
        payload: validPayload({ job: { jobId: "job-1", ticketId: "T-0460", sprintId: "wrong-sprint" } })
      },
      currentHead: SHA_A,
      ...archive
    });
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("identity-mismatch");
    expect(archive.appendEntryFn).not.toHaveBeenCalled();
  });

  // FIX ROUND (Dennie, human comment (b)): a schema-valid, identity-matching payload for the
  // right job/ticket/sprint/sha but a STALE acceptanceCriteriaVersion used to publish PASS
  // against a superseded contract for the same commit -- the identity check never compared it.
  it("rejects a result whose acceptanceCriteriaVersion doesn't match the dispatched version -- never publishes a PASS against a superseded contract", async () => {
    const archive = makeFakeArchive();
    const result = await publishCodexVerdict({
      tasksDir,
      taskId: "T-0460",
      deliveryId: "d1",
      dispatchedJob: dispatchedJob({ acceptanceCriteriaVersion: "v2" }),
      runResult: { kind: "payload", payload: validPayload({ acceptanceCriteriaVersion: "v1", outcome: "PASS" }) },
      currentHead: SHA_A,
      ...archive
    });
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("identity-mismatch");
    expect(archive.appendEntryFn).not.toHaveBeenCalled();
  });

  it("requires dispatchedJob.acceptanceCriteriaVersion -- a caller cannot dispatch without freezing the contract it expects back", async () => {
    const archive = makeFakeArchive();
    const job = dispatchedJob();
    delete job.acceptanceCriteriaVersion;
    await expect(
      publishCodexVerdict({
        tasksDir,
        taskId: "T-0460",
        deliveryId: "d1",
        dispatchedJob: job,
        runResult: { kind: "payload", payload: validPayload() },
        currentHead: SHA_A,
        ...archive
      })
    ).rejects.toThrow(/acceptanceCriteriaVersion/);
  });
});

// Also found live by T-0460's own real review run: omitting currentHead entirely (rather than
// passing the dispatched sha) silently skipped the "has the head moved" check altogether and
// published PASS unconditionally -- the exact failure mode "validating ... the CURRENT head"
// exists to prevent. currentHead is now a required argument, not an optional one that degrades
// to "assume it hasn't moved" when absent.
describe("publishCodexVerdict -- currentHead is required, never silently skipped", () => {
  it("throws when currentHead is missing", async () => {
    const archive = makeFakeArchive();
    await expect(
      publishCodexVerdict({
        tasksDir,
        taskId: "T-0460",
        deliveryId: "d1",
        dispatchedJob: dispatchedJob(),
        runResult: { kind: "payload", payload: validPayload() },
        ...archive
      })
    ).rejects.toThrow(/currentHead/);
    expect(archive.appendEntryFn).not.toHaveBeenCalled();
  });

  it("throws when currentHead is an empty string", async () => {
    const archive = makeFakeArchive();
    await expect(
      publishCodexVerdict({
        tasksDir,
        taskId: "T-0460",
        deliveryId: "d1",
        dispatchedJob: dispatchedJob(),
        runResult: { kind: "payload", payload: validPayload() },
        currentHead: "",
        ...archive
      })
    ).rejects.toThrow(/currentHead/);
  });
});

// Also found live: the pre-fix mechanism was read-existing-entries-then-append, two separate
// awaits with no lock between them -- a real concurrent repro (two identical deliveries
// in-flight at once, run as part of T-0460's own review) got "published" from both callers and
// two entries appended, violating exactly-once. The fix below is the claim-before-process step.
describe("publishCodexVerdict -- exactly-once under real concurrency, not just sequential retries", () => {
  it("two concurrent deliveries of the same deliveryId append exactly one entry between them", async () => {
    const archive = makeFakeArchive();
    const args = {
      tasksDir,
      taskId: "T-0460",
      deliveryId: "same-delivery-id",
      dispatchedJob: dispatchedJob(),
      runResult: { kind: "payload", payload: validPayload({ outcome: "PASS" }) },
      currentHead: SHA_A,
      ...archive
    };

    const [first, second] = await Promise.all([publishCodexVerdict(args), publishCodexVerdict(args)]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["duplicate", "published"]);
    expect(archive.appendEntryFn).toHaveBeenCalledTimes(1);
    expect(archive.store.get("T-0460")).toHaveLength(1);
  });
});

describe("publishCodexVerdict -- a head that moved during review", () => {
  it("retains the result and marks it superseded, requesting a fresh review, instead of discarding it or misapplying it", async () => {
    const archive = makeFakeArchive();
    const result = await publishCodexVerdict({
      tasksDir,
      taskId: "T-0460",
      deliveryId: "d1",
      dispatchedJob: dispatchedJob({ dispatchedSha: SHA_A }),
      runResult: { kind: "payload", payload: validPayload({ reviewedSha: SHA_A, outcome: "PASS" }) },
      currentHead: SHA_B, // the card moved on while the review was running
      ...archive
    });
    expect(result.status).toBe("superseded");
    expect(result.freshReviewRequested).toBe(true);
    expect(archive.appendEntryFn).toHaveBeenCalledTimes(1);
    expect(result.entry.heading).toContain("SUPERSEDED");
    expect(result.entry.outcome).toBe("PASS"); // what the model said is preserved, not discarded
    expect(result.entry.dispatchedSha).toBe(SHA_A);
  });
});

describe("publishCodexVerdict -- a result arriving after cancellation", () => {
  it("does not publish; reports rejection with a cancellation reason", async () => {
    const archive = makeFakeArchive();
    const result = await publishCodexVerdict({
      tasksDir,
      taskId: "T-0460",
      deliveryId: "d1",
      dispatchedJob: dispatchedJob(),
      runResult: { kind: "payload", payload: validPayload({ outcome: "PASS" }) },
      currentHead: SHA_A,
      cancelled: true,
      ...archive
    });
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("job-cancelled");
    expect(archive.appendEntryFn).not.toHaveBeenCalled();
  });
});

describe("publishCodexVerdict -- exactly-once on duplicate delivery", () => {
  it("delivering the identical result twice (retry/replay) produces exactly one appended entry", async () => {
    const archive = makeFakeArchive();
    const args = {
      tasksDir,
      taskId: "T-0460",
      deliveryId: "same-delivery-id",
      dispatchedJob: dispatchedJob(),
      runResult: { kind: "payload", payload: validPayload({ outcome: "PASS" }) },
      currentHead: SHA_A,
      ...archive
    };

    const first = await publishCodexVerdict(args);
    const second = await publishCodexVerdict(args);

    expect(first.status).toBe("published");
    expect(second.status).toBe("duplicate");
    expect(second.entry).toEqual(first.entry);
    expect(archive.appendEntryFn).toHaveBeenCalledTimes(1);
    expect(archive.store.get("T-0460")).toHaveLength(1);
  });

  it("a different deliveryId for the same task is not treated as a duplicate", async () => {
    const archive = makeFakeArchive();
    const base = { tasksDir, taskId: "T-0460", dispatchedJob: dispatchedJob(), currentHead: SHA_A, ...archive };

    await publishCodexVerdict({ ...base, deliveryId: "d1", runResult: { kind: "payload", payload: validPayload({ outcome: "PASS" }) } });
    const second = await publishCodexVerdict({
      ...base,
      deliveryId: "d2",
      runResult: { kind: "payload", payload: validPayload({ outcome: "CHANGES_REQUESTED" }) }
    });

    expect(second.status).toBe("published");
    expect(archive.appendEntryFn).toHaveBeenCalledTimes(2);
  });

  it("requires a non-empty deliveryId", async () => {
    const archive = makeFakeArchive();
    await expect(
      publishCodexVerdict({
        tasksDir,
        taskId: "T-0460",
        deliveryId: "",
        dispatchedJob: dispatchedJob(),
        runResult: { kind: "payload", payload: validPayload() },
        currentHead: SHA_A,
        ...archive
      })
    ).rejects.toThrow(/deliveryId/);
  });
});

// FIX ROUND (Dennie, human comment (a), P2): the pre-fix mechanism created its exclusive marker
// BEFORE appending and never recovered it -- an append failure, or the owning process dying
// before it could finish, permanently consumed the delivery: every retry read back
// `{status: "duplicate", entry: null}` and nothing was ever actually published. These four cases
// are exactly what Dennie's review asked to be covered, each with its own test.
describe("publishCodexVerdict -- recoverable delivery, not a one-shot claim that can strand a delivery forever", () => {
  it("append failure: a retry (same still-alive process) actually completes the publish instead of reading back duplicate/null forever", async () => {
    const archive = makeFakeArchive();
    const args = {
      tasksDir,
      taskId: "T-0460",
      deliveryId: "flaky-delivery",
      dispatchedJob: dispatchedJob(),
      runResult: { kind: "payload", payload: validPayload({ outcome: "PASS" }) },
      currentHead: SHA_A
    };

    const realAppend = archive.appendEntryFn;
    let calls = 0;
    const flakyAppend = vi.fn(async (...a) => {
      calls += 1;
      if (calls === 1) throw new Error("simulated disk-full on first append attempt");
      return realAppend(...a);
    });

    const first = await publishCodexVerdict({ ...args, readEntriesFn: archive.readEntriesFn, appendEntryFn: flakyAppend }).catch((err) => err);
    expect(first).toBeInstanceOf(Error);

    // The marker the failed attempt created must not have permanently consumed the delivery --
    // the retry below is what proves that, not an inspection of the marker file's own shape.
    const retry = await publishCodexVerdict({ ...args, readEntriesFn: archive.readEntriesFn, appendEntryFn: flakyAppend });

    expect(retry.status).toBe("published");
    expect(retry.entry.outcome).toBe("PASS");
    expect(flakyAppend).toHaveBeenCalledTimes(2);
    expect(archive.store.get("T-0460")).toHaveLength(1);
  });

  it("process death before append: a stale claim left by a dead pid is recovered and actually published, not read back as duplicate/null", async () => {
    const archive = makeFakeArchive();
    const deliveryId = "crashed-before-append";
    const markerPath = deliveryMarkerPath(tasksDir, "T-0460", deliveryId);
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    // Simulates the exact shape a real claim leaves behind the instant after createMarkerAtomic
    // succeeds but before the append that was about to follow -- the process died right here.
    await fs.writeFile(markerPath, JSON.stringify({ pid: 999999, claimedAt: new Date().toISOString() }), "utf8");

    const result = await publishCodexVerdict({
      tasksDir,
      taskId: "T-0460",
      deliveryId,
      dispatchedJob: dispatchedJob(),
      runResult: { kind: "payload", payload: validPayload({ outcome: "PASS" }) },
      currentHead: SHA_A,
      isPidAliveFn: (pid) => pid !== 999999, // the recorded claimant is dead; this process is not
      ...archive
    });

    expect(result.status).toBe("published");
    expect(result.entry.outcome).toBe("PASS");
    expect(archive.appendEntryFn).toHaveBeenCalledTimes(1);
    expect(archive.store.get("T-0460")).toHaveLength(1);

    const markerAfter = JSON.parse(await fs.readFile(markerPath, "utf8"));
    expect(markerAfter.completed).toBe(true);
  });

  it("process death after append but before completion marking: the archive already has the entry -- recovery must not append a second one", async () => {
    const archive = makeFakeArchive();
    const deliveryId = "crashed-after-append";
    const markerPath = deliveryMarkerPath(tasksDir, "T-0460", deliveryId);
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, JSON.stringify({ pid: 999999, claimedAt: new Date().toISOString() }), "utf8");

    // The append that the dead claimant made before it died, landed in the archive already.
    const alreadyPublishedEntry = { deliveryId, jobId: "job-1", ticketId: "T-0460", sprintId: "sprint-7", dispatchedSha: SHA_A, heading: "Codex Review: PASS", timestamp: "2026-10-21T00:00:00.000Z", outcome: "PASS", text: "..." };
    await archive.appendEntryFn(tasksDir, "T-0460", alreadyPublishedEntry);

    const result = await publishCodexVerdict({
      tasksDir,
      taskId: "T-0460",
      deliveryId,
      dispatchedJob: dispatchedJob(),
      runResult: { kind: "payload", payload: validPayload({ outcome: "PASS" }) },
      currentHead: SHA_A,
      isPidAliveFn: (pid) => pid !== 999999,
      ...archive
    });

    expect(result.status).toBe("duplicate");
    expect(result.entry).toEqual(alreadyPublishedEntry);
    expect(archive.appendEntryFn).toHaveBeenCalledTimes(1); // only the pre-seeded one -- no second append
    expect(archive.store.get("T-0460")).toHaveLength(1);
  });

  it("simultaneous retry of the same stale (dead-pid) claim: two concurrent recoverers still append exactly once", async () => {
    const archive = makeFakeArchive();
    const deliveryId = "crashed-simultaneous-retry";
    const markerPath = deliveryMarkerPath(tasksDir, "T-0460", deliveryId);
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, JSON.stringify({ pid: 999999, claimedAt: new Date().toISOString() }), "utf8");

    const args = {
      tasksDir,
      taskId: "T-0460",
      deliveryId,
      dispatchedJob: dispatchedJob(),
      runResult: { kind: "payload", payload: validPayload({ outcome: "PASS" }) },
      currentHead: SHA_A,
      isPidAliveFn: (pid) => pid !== 999999,
      ...archive
    };

    const [first, second] = await Promise.all([publishCodexVerdict(args), publishCodexVerdict(args)]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["duplicate", "published"]);
    expect(archive.appendEntryFn).toHaveBeenCalledTimes(1);
    expect(archive.store.get("T-0460")).toHaveLength(1);
  });
});

describe("publishCodexVerdict -- the happy path", () => {
  it("appends exactly one PASS verdict when identity, schema, and head all check out", async () => {
    const archive = makeFakeArchive();
    const result = await publishCodexVerdict({
      tasksDir,
      taskId: "T-0460",
      deliveryId: "d1",
      dispatchedJob: dispatchedJob(),
      runResult: { kind: "payload", payload: validPayload({ outcome: "PASS" }) },
      currentHead: SHA_A,
      ...archive
    });
    expect(result.status).toBe("published");
    expect(result.outcome).toBe("PASS");
    expect(archive.appendEntryFn).toHaveBeenCalledTimes(1);
    const [, taskId, entry] = archive.appendEntryFn.mock.calls[0];
    expect(taskId).toBe("T-0460");
    expect(entry.outcome).toBe("PASS");
    expect(entry.deliveryId).toBe("d1");
    expect(entry.dispatchedSha).toBe(SHA_A);
    expect(entry.acceptanceCriteriaVersion).toBe(ACV);
  });

  it("appends a CHANGES_REQUESTED verdict carrying its findings", async () => {
    const archive = makeFakeArchive();
    const result = await publishCodexVerdict({
      tasksDir,
      taskId: "T-0460",
      deliveryId: "d1",
      dispatchedJob: dispatchedJob(),
      runResult: {
        kind: "payload",
        payload: validPayload({ outcome: "CHANGES_REQUESTED", findings: [{ file: "a.js", line: 1, evidence: "x" }] })
      },
      currentHead: SHA_A,
      ...archive
    });
    expect(result.outcome).toBe("CHANGES_REQUESTED");
    expect(result.entry.text).toContain("a.js");
  });
});

describe("publishCodexVerdict -- the publisher is ordinary, deterministic code", () => {
  it("never mutates or returns anything granting merge authority or a protected-flag change -- its result is only a verdict-archive entry", async () => {
    const archive = makeFakeArchive();
    const result = await publishCodexVerdict({
      tasksDir,
      taskId: "T-0460",
      deliveryId: "d1",
      dispatchedJob: dispatchedJob(),
      runResult: { kind: "payload", payload: validPayload({ outcome: "PASS" }) },
      currentHead: SHA_A,
      ...archive
    });
    const allowedTopLevelKeys = new Set(["status", "outcome", "entry", "reason", "errors", "freshReviewRequested", "currentHead"]);
    expect(Object.keys(result).every((k) => allowedTopLevelKeys.has(k))).toBe(true);
    expect(result).not.toHaveProperty("merge");
    expect(result).not.toHaveProperty("approved");
  });
});
