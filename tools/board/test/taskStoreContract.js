import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TaskStore } from "../src/lib/taskStore.js";

export function makeTask(overrides = {}) {
  return {
    id: "T-0001",
    title: "Example task",
    status: "backlog",
    priority: "P1",
    phase: 1,
    agent: "infra",
    depends_on: [],
    created: "2026-07-31",
    branch: null,
    commit: null,
    pr: null,
    deliverable_type: "code",
    requires_approval: false,
    approved_by: null,
    approved_at: null,
    attempts: 0,
    comments: [],
    attachments: [],
    body: "## Context\n...\n## Acceptance\n- [ ] ...\n",
    ...overrides
  };
}

/**
 * Runs the same behavioral suite against any TaskStore implementation, so a
 * new store (e.g. DbTaskStore) is proven behaviorally identical to
 * FsTaskStore before it's ever wired into anything live -- see
 * docs/design/cards-to-database.md, Phase 1. `setup()` must return a fresh
 * `{ store, dispose }` pair per test; `dispose()` releases whatever
 * resources `setup()` allocated (temp dirs, open db handles).
 */
export function runTaskStoreContractTests(label, setup) {
  let store;
  let dispose;

  beforeEach(async () => {
    ({ store, dispose } = await setup());
  });

  afterEach(async () => {
    await dispose();
  });

  describe(`${label} is a TaskStore`, () => {
    it("is an instance of the abstract TaskStore", () => {
      expect(store).toBeInstanceOf(TaskStore);
    });
  });

  describe(`${label} CRUD`, () => {
    it("creates a task and reads it back", async () => {
      const task = makeTask();
      await store.create(task);
      expect(await store.get(task.id)).toEqual(task);
    });

    it("get returns null for a missing id", async () => {
      expect(await store.get("T-9999")).toBeNull();
    });

    it("list returns all tasks sorted by id", async () => {
      await store.create(makeTask({ id: "T-0003" }));
      await store.create(makeTask({ id: "T-0001" }));
      await store.create(makeTask({ id: "T-0002" }));
      const ids = (await store.list()).map((t) => t.id);
      expect(ids).toEqual(["T-0001", "T-0002", "T-0003"]);
    });

    it("update merges partial fields and persists them", async () => {
      const task = makeTask();
      await store.create(task);
      const updated = await store.update(task.id, { status: "ready", title: "Renamed" });
      expect(updated).toMatchObject({
        id: task.id,
        status: "ready",
        title: "Renamed",
        priority: task.priority
      });
      expect(await store.get(task.id)).toEqual(updated);
    });

    it("update throws for a task that does not exist", async () => {
      await expect(store.update("T-9999", { status: "ready" })).rejects.toThrow(/not found/i);
    });

    it("update rejects attempts to change the task id", async () => {
      const task = makeTask();
      await store.create(task);
      await expect(store.update(task.id, { id: "T-9999" })).rejects.toThrow(/id/i);
    });

    it("move updates only the status field", async () => {
      const task = makeTask();
      await store.create(task);
      const moved = await store.move(task.id, "in-progress");
      expect(moved).toEqual({ ...task, status: "in-progress" });
    });
  });

  describe(`${label} depends_on`, () => {
    it("persists depends_on and preserves array order", async () => {
      await store.create(makeTask({ id: "T-0001" }));
      await store.create(makeTask({ id: "T-0002" }));
      const task = makeTask({ id: "T-0003", depends_on: ["T-0002", "T-0001"] });
      await store.create(task);
      expect(await store.get("T-0003")).toEqual(task);
    });

    it("update replaces depends_on wholesale when the field is provided", async () => {
      await store.create(makeTask({ id: "T-0001" }));
      await store.create(makeTask({ id: "T-0002" }));
      const task = makeTask({ id: "T-0003", depends_on: ["T-0001"] });
      await store.create(task);

      const updated = await store.update(task.id, { depends_on: ["T-0002"] });
      expect(updated.depends_on).toEqual(["T-0002"]);
      expect(await store.get(task.id)).toMatchObject({ depends_on: ["T-0002"] });
    });
  });

  describe(`${label} comments`, () => {
    it("persists an appended comment and reads it back", async () => {
      const task = makeTask();
      await store.create(task);
      const comment = {
        author: "Dennie",
        text: "please fix the CI failure",
        timestamp: "2026-08-05T12:00:00.000Z"
      };
      const updated = await store.update(task.id, { comments: [comment] });
      expect(updated.comments).toEqual([comment]);
      expect(await store.get(task.id)).toEqual(updated);
    });

    it("survives an unrelated update -- a status/body write never clobbers existing comments", async () => {
      const task = makeTask();
      await store.create(task);
      const comment = { author: "Dennie", text: "fix X", timestamp: "2026-08-05T12:00:00.000Z" };
      await store.update(task.id, { comments: [comment] });

      const updated = await store.update(task.id, { status: "in-progress", body: "## Notes\nre-run" });

      expect(updated.comments).toEqual([comment]);
      expect(await store.get(task.id)).toMatchObject({ comments: [comment], status: "in-progress" });
    });

    it("preserves comment order across multiple appends", async () => {
      const task = makeTask();
      await store.create(task);
      const first = { author: "Dennie", text: "first", timestamp: "2026-08-05T12:00:00.000Z" };
      const second = { author: "Dennie", text: "second", timestamp: "2026-08-05T12:05:00.000Z" };
      await store.update(task.id, { comments: [first] });
      const updated = await store.update(task.id, { comments: [first, second] });
      expect(updated.comments).toEqual([first, second]);
      expect(await store.get(task.id)).toMatchObject({ comments: [first, second] });
    });
  });

  describe(`${label} attachments`, () => {
    it("persists an appended attachment and reads it back", async () => {
      const task = makeTask();
      await store.create(task);
      const attachment = {
        filename: "reference.png",
        size: 1024,
        mimetype: "image/png",
        uploaded_by: "Dennie",
        uploaded_at: "2026-08-05T12:00:00.000Z"
      };
      const updated = await store.update(task.id, { attachments: [attachment] });
      expect(updated.attachments).toEqual([attachment]);
      expect(await store.get(task.id)).toEqual(updated);
    });

    it("survives an unrelated update -- a status/body write never clobbers existing attachments", async () => {
      const task = makeTask();
      await store.create(task);
      const attachment = {
        filename: "reference.png",
        size: 1024,
        mimetype: "image/png",
        uploaded_by: "Dennie",
        uploaded_at: "2026-08-05T12:00:00.000Z"
      };
      await store.update(task.id, { attachments: [attachment] });

      const updated = await store.update(task.id, { status: "in-progress", body: "## Notes\nre-run" });

      expect(updated.attachments).toEqual([attachment]);
      expect(await store.get(task.id)).toMatchObject({ attachments: [attachment], status: "in-progress" });
    });
  });

  describe(`${label} remove`, () => {
    it("deletes the task", async () => {
      const task = makeTask();
      await store.create(task);
      await store.remove(task.id);
      expect(await store.get(task.id)).toBeNull();
    });

    it("throws when removing a task that does not exist", async () => {
      await expect(store.remove("T-9999")).rejects.toThrow(/not found/i);
    });
  });

  describe(`${label} id collisions`, () => {
    it("rejects creating a task whose id already exists", async () => {
      await store.create(makeTask({ id: "T-0001" }));
      await expect(store.create(makeTask({ id: "T-0001", title: "Different" }))).rejects.toThrow(
        /already exists/i
      );
    });

    it("leaves the original record untouched after a rejected collision", async () => {
      const original = makeTask({ id: "T-0001" });
      await store.create(original);
      await expect(store.create(makeTask({ id: "T-0001", title: "Different" }))).rejects.toThrow();
      expect(await store.get("T-0001")).toEqual(original);
    });
  });

  describe(`${label} interchangeability`, () => {
    it("tolerates an optional trailing options object on create/update/move/remove", async () => {
      // Not part of the TaskStore contract's required arity -- an actor-tagging extension
      // (see DbTaskStore's card_events audit trail) that must not break either store when
      // called uniformly by a future shared call site.
      const task = makeTask();
      await store.create(task, { actor: "tester" });
      await store.update(task.id, { status: "ready" }, { actor: "tester" });
      await store.move(task.id, "in-progress", { actor: "tester" });
      expect(await store.get(task.id)).toMatchObject({ status: "in-progress" });
      await store.remove(task.id, { actor: "tester" });
      expect(await store.get(task.id)).toBeNull();
    });
  });
}
