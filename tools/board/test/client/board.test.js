import { describe, it, expect } from "vitest";
import {
  STATUSES,
  groupTasksByStatus,
  buildStatusPatch,
  applyTaskEvent,
  computeBlockerCounts,
  sortTasks
} from "../../src/client/board.js";

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

describe("computeBlockerCounts", () => {
  it("counts a task once for each other task that lists it in depends_on", () => {
    const tasks = [
      task({ id: "T-0001", depends_on: [] }),
      task({ id: "T-0002", depends_on: ["T-0001"] }),
      task({ id: "T-0003", depends_on: ["T-0001"] })
    ];
    const counts = computeBlockerCounts(tasks);
    expect(counts.get("T-0001")).toBe(2);
  });

  it("does not include a task with no dependents", () => {
    const tasks = [task({ id: "T-0001", depends_on: [] }), task({ id: "T-0002", depends_on: [] })];
    const counts = computeBlockerCounts(tasks);
    expect(counts.has("T-0001")).toBe(false);
    expect(counts.has("T-0002")).toBe(false);
  });

  it("counts each dependency independently for a task with multiple depends_on entries", () => {
    const tasks = [
      task({ id: "T-0001", depends_on: [] }),
      task({ id: "T-0002", depends_on: [] }),
      task({ id: "T-0003", depends_on: ["T-0001", "T-0002"] })
    ];
    const counts = computeBlockerCounts(tasks);
    expect(counts.get("T-0001")).toBe(1);
    expect(counts.get("T-0002")).toBe(1);
  });
});

describe("sortTasks", () => {
  function t(overrides) {
    return task(overrides);
  }

  it("sorts by id numerically (not lexicographically)", () => {
    const tasks = [t({ id: "T-0010" }), t({ id: "T-0002" }), t({ id: "T-0001" })];
    expect(sortTasks(tasks, "id").map((x) => x.id)).toEqual(["T-0001", "T-0002", "T-0010"]);
  });

  it("sorts by priority rank P0 < P1 < P2 < P3", () => {
    const tasks = [
      t({ id: "T-0001", priority: "P3" }),
      t({ id: "T-0002", priority: "P0" }),
      t({ id: "T-0003", priority: "P2" }),
      t({ id: "T-0004", priority: "P1" })
    ];
    expect(sortTasks(tasks, "priority").map((x) => x.id)).toEqual(["T-0002", "T-0004", "T-0003", "T-0001"]);
  });

  it("sorts by agent alphabetically, with unassigned (null) first", () => {
    const tasks = [
      t({ id: "T-0001", agent: "server" }),
      t({ id: "T-0002", agent: null }),
      t({ id: "T-0003", agent: "infra" })
    ];
    expect(sortTasks(tasks, "agent").map((x) => x.id)).toEqual(["T-0002", "T-0003", "T-0001"]);
  });

  it("sorts by phase numerically", () => {
    const tasks = [t({ id: "T-0001", phase: 3 }), t({ id: "T-0002", phase: 1 }), t({ id: "T-0003", phase: 2 })];
    expect(sortTasks(tasks, "phase").map((x) => x.id)).toEqual(["T-0002", "T-0003", "T-0001"]);
  });

  it("breaks ties by id within the same sort key", () => {
    const tasks = [
      t({ id: "T-0003", priority: "P1" }),
      t({ id: "T-0001", priority: "P1" }),
      t({ id: "T-0002", priority: "P1" })
    ];
    expect(sortTasks(tasks, "priority").map((x) => x.id)).toEqual(["T-0001", "T-0002", "T-0003"]);
  });

  it("does not mutate the input array", () => {
    const tasks = [t({ id: "T-0002" }), t({ id: "T-0001" })];
    sortTasks(tasks, "id");
    expect(tasks.map((x) => x.id)).toEqual(["T-0002", "T-0001"]);
  });

  it("falls back to id order for an unknown sort key", () => {
    const tasks = [t({ id: "T-0002" }), t({ id: "T-0001" })];
    expect(sortTasks(tasks, "bogus").map((x) => x.id)).toEqual(["T-0001", "T-0002"]);
  });
});
