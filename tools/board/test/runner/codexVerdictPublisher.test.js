import { describe, it, expect, vi } from "vitest";
import { publishCodexVerdict } from "../../src/runner/codexVerdictPublisher.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function dispatchedJob(overrides = {}) {
  return { jobId: "job-1", ticketId: "T-0460", sprintId: "sprint-7", dispatchedSha: SHA_A, ...overrides };
}

function validPayload(overrides = {}) {
  return {
    job: { jobId: "job-1", ticketId: "T-0460", sprintId: "sprint-7" },
    reviewedSha: SHA_A,
    acceptanceCriteriaVersion: "2026-10-21",
    outcome: "PASS",
    findings: [],
    checksPerformed: ["npx vitest run"],
    limitations: [],
    ...overrides
  };
}

/** An in-memory stand-in for verdictArchive's readVerdictEntries/appendVerdictEntry, keyed by taskId. */
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

describe("publishCodexVerdict -- failed process or invalid result is BLOCKED, never PASS", () => {
  it("non-zero exit -> published as BLOCKED", async () => {
    const archive = makeFakeArchive();
    const result = await publishCodexVerdict({
      tasksDir: "/tasks",
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
      tasksDir: "/tasks",
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
      tasksDir: "/tasks",
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
      tasksDir: "/tasks",
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
      tasksDir: "/tasks",
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
      tasksDir: "/tasks",
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
      tasksDir: "/tasks",
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
      tasksDir: "/tasks",
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
});

describe("publishCodexVerdict -- a head that moved during review", () => {
  it("retains the result and marks it superseded, requesting a fresh review, instead of discarding it or misapplying it", async () => {
    const archive = makeFakeArchive();
    const result = await publishCodexVerdict({
      tasksDir: "/tasks",
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
      tasksDir: "/tasks",
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
      tasksDir: "/tasks",
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
    expect(archive.appendEntryFn).toHaveBeenCalledTimes(1);
    expect(archive.store.get("T-0460")).toHaveLength(1);
  });

  it("a different deliveryId for the same task is not treated as a duplicate", async () => {
    const archive = makeFakeArchive();
    const base = { tasksDir: "/tasks", taskId: "T-0460", dispatchedJob: dispatchedJob(), currentHead: SHA_A, ...archive };

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
        tasksDir: "/tasks",
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

describe("publishCodexVerdict -- the happy path", () => {
  it("appends exactly one PASS verdict when identity, schema, and head all check out", async () => {
    const archive = makeFakeArchive();
    const result = await publishCodexVerdict({
      tasksDir: "/tasks",
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
  });

  it("appends a CHANGES_REQUESTED verdict carrying its findings", async () => {
    const archive = makeFakeArchive();
    const result = await publishCodexVerdict({
      tasksDir: "/tasks",
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
      tasksDir: "/tasks",
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
