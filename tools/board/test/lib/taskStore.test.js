import { describe, it, expect } from "vitest";
import { StaleWriteError, hashBody, findMismatchedExpectedFields, expectedConditionHolds } from "../../src/lib/taskStore.js";

/**
 * T-0384 FIX ROUND 2 (Codex P2 #1, head d81d474c): the conditional-write `expected` precondition
 * used to compare `status` alone, so a body/agent/deliverable_type/depends_on change that left
 * status untouched was invisible to it. These are the shared primitives both FsTaskStore and
 * DbTaskStore now use to check a fingerprint covering every vetted field, not just status.
 */

describe("hashBody", () => {
  it("hashes identical bodies to the same digest", () => {
    expect(hashBody("## Acceptance\n- [ ] Do the thing.\n")).toBe(hashBody("## Acceptance\n- [ ] Do the thing.\n"));
  });

  it("hashes a changed body to a different digest", () => {
    expect(hashBody("## Acceptance\n- [ ] Do the thing.\n")).not.toBe(hashBody("## Held\nDo not ready.\n"));
  });

  it("treats a missing/null body the same as an empty string", () => {
    expect(hashBody(undefined)).toBe(hashBody(""));
    expect(hashBody(null)).toBe(hashBody(""));
  });
});

describe("findMismatchedExpectedFields", () => {
  const task = {
    status: "backlog",
    agent: "infra",
    deliverable_type: "code",
    requires_approval: false,
    depends_on: ["T-0001", "T-0002"],
    body: "## Acceptance\n- [ ] Do the thing.\n"
  };

  it("returns an empty list when every expected field matches", () => {
    expect(
      findMismatchedExpectedFields(
        { status: "backlog", agent: "infra", depends_on: ["T-0001", "T-0002"], bodyHash: hashBody(task.body) },
        task
      )
    ).toEqual([]);
  });

  it("names a plain scalar field that no longer matches", () => {
    expect(findMismatchedExpectedFields({ status: "in-progress" }, task)).toEqual(["status"]);
  });

  it("names 'body' (not 'bodyHash') when the body hash no longer matches", () => {
    expect(findMismatchedExpectedFields({ bodyHash: hashBody("## Held\nDo not ready.\n") }, task)).toEqual(["body"]);
  });

  // depends_on is an array -- naive `!==` comparison would always report a mismatch (different
  // array reference) even when the contents are identical, since `expected` always arrives via a
  // fresh JSON round-trip (an HTTP header, or a store's own separate read).
  it("compares depends_on by contents, not by array reference", () => {
    expect(findMismatchedExpectedFields({ depends_on: ["T-0001", "T-0002"] }, task)).toEqual([]);
    expect(findMismatchedExpectedFields({ depends_on: [...task.depends_on] }, task)).toEqual([]);
  });

  it("reports depends_on as changed when its contents differ", () => {
    expect(findMismatchedExpectedFields({ depends_on: ["T-0001"] }, task)).toEqual(["depends_on"]);
    expect(findMismatchedExpectedFields({ depends_on: ["T-0001", "T-0002", "T-0003"] }, task)).toEqual(["depends_on"]);
  });

  it("names every mismatched field, not just the first", () => {
    expect(
      findMismatchedExpectedFields({ status: "done", agent: "server", bodyHash: hashBody("## Held\n") }, task)
    ).toEqual(["status", "agent", "body"]);
  });

  it("returns an empty list when expected is null/undefined", () => {
    expect(findMismatchedExpectedFields(null, task)).toEqual([]);
    expect(findMismatchedExpectedFields(undefined, task)).toEqual([]);
  });
});

describe("expectedConditionHolds", () => {
  const task = { status: "backlog", body: "## Acceptance\n- [ ] Do the thing.\n" };

  it("is true when nothing is expected", () => {
    expect(expectedConditionHolds(undefined, task)).toBe(true);
  });

  it("is true when every expected field matches", () => {
    expect(expectedConditionHolds({ status: "backlog", bodyHash: hashBody(task.body) }, task)).toBe(true);
  });

  it("is false when any expected field mismatches", () => {
    expect(expectedConditionHolds({ status: "backlog", bodyHash: hashBody("## Held\n") }, task)).toBe(false);
  });
});

describe("StaleWriteError", () => {
  it("names the mismatched field(s) in its message when given changedFields", () => {
    const err = new StaleWriteError("T-9001", { status: "backlog" }, { status: "done" }, ["status"]);
    expect(err.changedFields).toEqual(["status"]);
    expect(err.message).toMatch(/status/);
  });

  it("still works with no changedFields argument (backward compatible)", () => {
    const err = new StaleWriteError("T-9001", { status: "backlog" }, { status: "done" });
    expect(err.changedFields).toEqual([]);
    expect(err.statusCode).toBe(409);
  });
});
