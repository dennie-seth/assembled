import { describe, it, expect } from "vitest";
import { STATUSES, groupTasksByStatus, buildStatusPatch, applyTaskEvent } from "../../src/client/board.js";

function task(overrides = {}) {
  return {
    id: "T-0001",
    title: "Sample",
    status: "backlog",
    priority: "P2",
    phase: 1,
    agent: null,
    depends_on: [],
    created: "2026-07-31",
    body: "",
    ...overrides
  };
}

describe("groupTasksByStatus", () => {
  it("creates one bucket per known status, in order, even when empty", () => {
    const grouped = groupTasksByStatus([]);
    expect([...grouped.keys()]).toEqual(STATUSES);
    for (const status of STATUSES) {
      expect(grouped.get(status)).toEqual([]);
    }
  });

  it("buckets tasks by their status field", () => {
    const tasks = [task({ id: "T-0001", status: "backlog" }), task({ id: "T-0002", status: "review" })];
    const grouped = groupTasksByStatus(tasks);
    expect(grouped.get("backlog")).toEqual([tasks[0]]);
    expect(grouped.get("review")).toEqual([tasks[1]]);
    expect(grouped.get("done")).toEqual([]);
  });

  it("falls back to creating a bucket for an unknown status rather than dropping the task", () => {
    const tasks = [task({ id: "T-0001", status: "weird" })];
    const grouped = groupTasksByStatus(tasks);
    expect(grouped.get("weird")).toEqual([tasks[0]]);
  });
});

describe("buildStatusPatch", () => {
  it("produces a PATCH payload containing only the new status", () => {
    expect(buildStatusPatch("in-progress")).toEqual({ status: "in-progress" });
  });
});

describe("applyTaskEvent", () => {
  it("replaces an existing task on a changed event", () => {
    const tasks = [task({ id: "T-0001", title: "Old" })];
    const updated = task({ id: "T-0001", title: "New" });
    const next = applyTaskEvent(tasks, { type: "changed", id: "T-0001", task: updated });
    expect(next).toEqual([updated]);
  });

  it("appends a task on an added event for an id not yet known", () => {
    const tasks = [task({ id: "T-0001" })];
    const added = task({ id: "T-0002" });
    const next = applyTaskEvent(tasks, { type: "added", id: "T-0002", task: added });
    expect(next).toEqual([tasks[0], added]);
  });

  it("removes a task on a removed event", () => {
    const tasks = [task({ id: "T-0001" }), task({ id: "T-0002" })];
    const next = applyTaskEvent(tasks, { type: "removed", id: "T-0001", task: null });
    expect(next).toEqual([tasks[1]]);
  });

  it("does not mutate the input array", () => {
    const tasks = [task({ id: "T-0001", title: "Old" })];
    applyTaskEvent(tasks, { type: "changed", id: "T-0001", task: task({ id: "T-0001", title: "New" }) });
    expect(tasks[0].title).toBe("Old");
  });
});
