import { describe, it, expect } from "vitest";
import {
  StaleWriteError,
  DependencyNotSatisfiedError,
  hashBody,
  findMismatchedExpectedFields,
  findUnsatisfiedDependencies,
  expectedConditionHolds
} from "../../src/lib/taskStore.js";

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

/**
 * T-0384 FIX ROUND 4 (Codex review 2026-09-19, P2 #2): a dependency re-check in an earlier GET
 * alone does not close the race between vet-and-ready's own check and the actual write -- the
 * atomic ready operation itself (the DbTaskStore transaction, the FsTaskStore per-id lock) has to
 * verify every depends_on id is still `done`/`retired` at write time. These are the shared,
 * pure primitives both stores use for that check.
 */
describe("findUnsatisfiedDependencies", () => {
  it("returns an empty list when every dependency is done or retired", () => {
    const statusById = new Map([
      ["T-0001", "done"],
      ["T-0002", "retired"]
    ]);
    expect(findUnsatisfiedDependencies(["T-0001", "T-0002"], statusById)).toEqual([]);
  });

  it("names a dependency that is neither done nor retired, with its current status", () => {
    const statusById = new Map([["T-0001", "backlog"]]);
    expect(findUnsatisfiedDependencies(["T-0001"], statusById)).toEqual([{ id: "T-0001", status: "backlog" }]);
  });

  it("treats a dependency absent from statusById as unmet, with a null status", () => {
    expect(findUnsatisfiedDependencies(["T-9999"], new Map())).toEqual([{ id: "T-9999", status: null }]);
  });

  it("returns an empty list for an empty/missing depends_on", () => {
    expect(findUnsatisfiedDependencies([], new Map())).toEqual([]);
    expect(findUnsatisfiedDependencies(undefined, new Map())).toEqual([]);
  });

  it("names every unmet dependency, not just the first", () => {
    const statusById = new Map([
      ["T-0001", "backlog"],
      ["T-0002", "done"],
      ["T-0003", "in-progress"]
    ]);
    expect(findUnsatisfiedDependencies(["T-0001", "T-0002", "T-0003"], statusById)).toEqual([
      { id: "T-0001", status: "backlog" },
      { id: "T-0003", status: "in-progress" }
    ]);
  });
});

describe("DependencyNotSatisfiedError", () => {
  it("names the unmet dependency and its status in the message, and carries statusCode 409", () => {
    const err = new DependencyNotSatisfiedError("T-9001", [{ id: "T-0099", status: "backlog" }]);
    expect(err.name).toBe("DependencyNotSatisfiedError");
    expect(err.statusCode).toBe(409);
    expect(err.id).toBe("T-9001");
    expect(err.unmet).toEqual([{ id: "T-0099", status: "backlog" }]);
    expect(err.message).toMatch(/T-0099/);
    expect(err.message).toMatch(/backlog/);
  });

  it("reports a null status as not found, not as a crash", () => {
    const err = new DependencyNotSatisfiedError("T-9001", [{ id: "T-0099", status: null }]);
    expect(err.message).toMatch(/T-0099/);
    expect(err.message).toMatch(/not found/i);
  });
});
