import { describe, it, expect } from "vitest";
import {
  assertCanMoveToInProgress,
  UnmetDependencyError,
  DependencyCycleError
} from "../src/lib/dependencyGuard.js";

function task(overrides = {}) {
  return {
    id: "T-0001",
    title: "Task",
    status: "ready",
    priority: "P1",
    phase: 1,
    agent: null,
    depends_on: [],
    created: "2026-07-31",
    body: "",
    ...overrides
  };
}

function makeStore(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return {
    async get(id) {
      return byId.get(id) ?? null;
    }
  };
}

describe("assertCanMoveToInProgress", () => {
  it("resolves without error when the task has no dependencies", async () => {
    const store = makeStore([task({ id: "T-0001", depends_on: [] })]);
    await expect(assertCanMoveToInProgress(store, "T-0001")).resolves.toBeUndefined();
  });

  it("resolves without error when all dependencies are done", async () => {
    const store = makeStore([
      task({ id: "T-0001", depends_on: ["T-0002", "T-0003"] }),
      task({ id: "T-0002", status: "done" }),
      task({ id: "T-0003", status: "done" })
    ]);
    await expect(assertCanMoveToInProgress(store, "T-0001")).resolves.toBeUndefined();
  });

  it("rejects with UnmetDependencyError listing the unmet dependency ids", async () => {
    const store = makeStore([
      task({ id: "T-0001", depends_on: ["T-0002", "T-0003"] }),
      task({ id: "T-0002", status: "done" }),
      task({ id: "T-0003", status: "in-progress" })
    ]);

    const err = await assertCanMoveToInProgress(store, "T-0001").catch((e) => e);
    expect(err).toBeInstanceOf(UnmetDependencyError);
    expect(err.unmetIds).toEqual(["T-0003"]);
    expect(err.message).toMatch(/T-0003/);
  });

  it("treats a missing dependency task as unmet", async () => {
    const store = makeStore([task({ id: "T-0001", depends_on: ["T-0099"] })]);
    const err = await assertCanMoveToInProgress(store, "T-0001").catch((e) => e);
    expect(err).toBeInstanceOf(UnmetDependencyError);
    expect(err.unmetIds).toEqual(["T-0099"]);
  });

  it("rejects with DependencyCycleError when a 2-node cycle exists, without hanging", async () => {
    const store = makeStore([
      task({ id: "T-0001", depends_on: ["T-0002"] }),
      task({ id: "T-0002", depends_on: ["T-0001"] })
    ]);

    const err = await assertCanMoveToInProgress(store, "T-0001").catch((e) => e);
    expect(err).toBeInstanceOf(DependencyCycleError);
  });

  it("rejects with DependencyCycleError for a longer transitive cycle", async () => {
    const store = makeStore([
      task({ id: "T-0001", depends_on: ["T-0002"] }),
      task({ id: "T-0002", depends_on: ["T-0003"] }),
      task({ id: "T-0003", depends_on: ["T-0001"] })
    ]);

    const err = await assertCanMoveToInProgress(store, "T-0001").catch((e) => e);
    expect(err).toBeInstanceOf(DependencyCycleError);
  });

  it("rejects with DependencyCycleError when a task depends on itself", async () => {
    const store = makeStore([task({ id: "T-0001", depends_on: ["T-0001"] })]);
    const err = await assertCanMoveToInProgress(store, "T-0001").catch((e) => e);
    expect(err).toBeInstanceOf(DependencyCycleError);
  });

  it("resolves without error when all dependencies are retired", async () => {
    const store = makeStore([
      task({ id: "T-0001", depends_on: ["T-0002"] }),
      task({ id: "T-0002", status: "retired" })
    ]);
    await expect(assertCanMoveToInProgress(store, "T-0001")).resolves.toBeUndefined();
  });

  it("resolves without error when dependencies mix done and retired", async () => {
    const store = makeStore([
      task({ id: "T-0001", depends_on: ["T-0002", "T-0003"] }),
      task({ id: "T-0002", status: "done" }),
      task({ id: "T-0003", status: "retired" })
    ]);
    await expect(assertCanMoveToInProgress(store, "T-0001")).resolves.toBeUndefined();
  });

  it("does not flag a diamond dependency graph (shared dep, no cycle) as a cycle", async () => {
    const store = makeStore([
      task({ id: "T-0001", depends_on: ["T-0002", "T-0003"] }),
      task({ id: "T-0002", depends_on: ["T-0004"], status: "done" }),
      task({ id: "T-0003", depends_on: ["T-0004"], status: "done" }),
      task({ id: "T-0004", status: "done" })
    ]);
    await expect(assertCanMoveToInProgress(store, "T-0001")).resolves.toBeUndefined();
  });
});
