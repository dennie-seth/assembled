import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TaskStore, StaleWriteError, DependencyNotSatisfiedError, hashBody } from "../src/lib/taskStore.js";

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
    max_attempts: null,
    round: 0,
    rescoped_by: null,
    rescoped_at: null,
    complexity_points: null,
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

    it("persists a max_attempts override (T-0343) and reads it back", async () => {
      const task = makeTask({ max_attempts: 2 });
      await store.create(task);
      expect(await store.get(task.id)).toEqual(task);
    });

    it("persists the round cap counter and rescope record (T-0344) and reads them back", async () => {
      const task = makeTask({ round: 2, rescoped_by: "@DennieSeth", rescoped_at: "2026-09-10T12:00:00.000Z" });
      await store.create(task);
      expect(await store.get(task.id)).toEqual(task);
    });

    it("persists a complexity_points value (T-0368: human planning signal only) and reads it back", async () => {
      const task = makeTask({ complexity_points: 5 });
      await store.create(task);
      expect(await store.get(task.id)).toEqual(task);
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

  // Codex review 2026-09-18 (T-0384), finding 3: a vet-and-ready re-check followed by an
  // unconditional PATCH is a TOCTOU race -- a card that changed status between the check and the
  // write got overwritten anyway. `update`'s optional `{ expected }` option lets a caller assert
  // the current record still matches before the write commits, atomically with the write itself
  // (not as a separate read the caller does on its own, which would just move the race).
  describe(`${label} conditional update`, () => {
    it("applies the write when every expected field matches the current record", async () => {
      const task = makeTask();
      await store.create(task);
      const updated = await store.update(task.id, { status: "ready" }, { expected: { status: "backlog" } });
      expect(updated.status).toBe("ready");
      expect(await store.get(task.id)).toMatchObject({ status: "ready" });
    });

    it("refuses the write with a StaleWriteError when an expected field no longer matches, and leaves the record untouched", async () => {
      const task = makeTask();
      await store.create(task);
      await store.update(task.id, { status: "in-progress" });

      await expect(
        store.update(task.id, { status: "ready" }, { expected: { status: "backlog" } })
      ).rejects.toThrow(StaleWriteError);
      expect(await store.get(task.id)).toMatchObject({ status: "in-progress" });
    });

    it("checks every field named in `expected`, not just the first", async () => {
      const task = makeTask({ priority: "P1" });
      await store.create(task);
      await expect(
        store.update(
          task.id,
          { status: "ready" },
          { expected: { status: "backlog", priority: "P0" } }
        )
      ).rejects.toThrow(StaleWriteError);
      expect(await store.get(task.id)).toMatchObject({ status: "backlog", priority: "P1" });
    });

    it("writes normally when no `expected` option is given at all (backward compatible)", async () => {
      const task = makeTask();
      await store.create(task);
      const updated = await store.update(task.id, { status: "ready" });
      expect(updated.status).toBe("ready");
    });

    it("still throws a not-found error for a missing id even with an expected option present", async () => {
      await expect(
        store.update("T-9999", { status: "ready" }, { expected: { status: "backlog" } })
      ).rejects.toThrow(/not found/i);
    });

    // T-0384 FIX ROUND 2 (Codex P2 #1, head d81d474c): `expected` used to only ever carry
    // `status`, so a concurrent change to body/agent/deliverable_type/depends_on that left status
    // alone was invisible to the precondition -- a card could be conditionally "readied" over a
    // Held marker a human had just written. `expected` now accepts a fingerprint covering every
    // vetted field, checked atomically alongside status.
    it("refuses a conditional write when the body changed (via bodyHash), even though status still matches", async () => {
      const task = makeTask({ body: "## Acceptance\n- [ ] Do the thing.\n" });
      await store.create(task);
      await store.update(task.id, { body: "## Held\nDo not ready this card.\n" });

      await expect(
        store.update(
          task.id,
          { status: "ready" },
          { expected: { status: "backlog", bodyHash: hashBody(task.body) } }
        )
      ).rejects.toThrow(StaleWriteError);
      expect(await store.get(task.id)).toMatchObject({ status: "backlog", body: "## Held\nDo not ready this card.\n" });
    });

    it("applies a conditional write when the observed bodyHash still matches the current body", async () => {
      const task = makeTask({ body: "## Acceptance\n- [ ] Do the thing.\n" });
      await store.create(task);
      const updated = await store.update(
        task.id,
        { status: "ready" },
        { expected: { status: "backlog", bodyHash: hashBody(task.body) } }
      );
      expect(updated.status).toBe("ready");
    });

    // depends_on is an array: naive reference equality would make every conditional write on a
    // task with dependencies fail, since `expected.depends_on` always arrives as a fresh array
    // (deserialized from JSON over HTTP, or read separately from the store) rather than the same
    // reference the store holds.
    it("compares an expected depends_on by contents, not by array identity", async () => {
      const task = makeTask({ depends_on: ["T-0001", "T-0002"] });
      await store.create(task);
      const updated = await store.update(
        task.id,
        { status: "ready" },
        { expected: { status: "backlog", depends_on: ["T-0001", "T-0002"] } }
      );
      expect(updated.status).toBe("ready");
    });

    it("refuses a conditional write when depends_on changed since it was observed", async () => {
      const task = makeTask({ depends_on: ["T-0001"] });
      await store.create(task);
      await store.update(task.id, { depends_on: ["T-0001", "T-0002"] });

      await expect(
        store.update(task.id, { status: "ready" }, { expected: { status: "backlog", depends_on: ["T-0001"] } })
      ).rejects.toThrow(StaleWriteError);
    });

    it("names every mismatched field on the thrown StaleWriteError, not just status", async () => {
      const task = makeTask({ agent: "infra" });
      await store.create(task);
      await store.update(task.id, { agent: "server" });

      let caught = null;
      try {
        await store.update(
          task.id,
          { status: "ready" },
          { expected: { status: "backlog", agent: "infra" } }
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(StaleWriteError);
      expect(caught.changedFields).toContain("agent");
    });
  });

  // T-0384 FIX ROUND 4 (Codex review 2026-09-19, P2 #2): a caller's own re-check of a
  // dependency's status, done via a separate `get`/`list` call before this write, is not atomic
  // with the write itself -- the dependency can regress in the gap between that check and this
  // call actually landing. `requireDependenciesSatisfied` asks the store to verify every
  // `depends_on` id is still `done`/`retired` INSIDE the same atomic operation as the write, so
  // that gap is closed. Opt-in: omitting it (or leaving it false) never runs this check at all,
  // exactly like `expected` before T-0384.
  describe(`${label} requireDependenciesSatisfied`, () => {
    it("applies the write when every dependency is done or retired", async () => {
      await store.create(makeTask({ id: "T-0090", status: "done" }));
      await store.create(makeTask({ id: "T-0091", status: "retired" }));
      const task = makeTask({ id: "T-0001", depends_on: ["T-0090", "T-0091"] });
      await store.create(task);

      const updated = await store.update(task.id, { status: "ready" }, { requireDependenciesSatisfied: true });
      expect(updated.status).toBe("ready");
    });

    it("refuses the write with a DependencyNotSatisfiedError naming the unmet dependency and its current status", async () => {
      await store.create(makeTask({ id: "T-0090", status: "backlog" }));
      const task = makeTask({ id: "T-0001", depends_on: ["T-0090"] });
      await store.create(task);

      let caught = null;
      try {
        await store.update(task.id, { status: "ready" }, { requireDependenciesSatisfied: true });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DependencyNotSatisfiedError);
      expect(caught.unmet).toEqual([{ id: "T-0090", status: "backlog" }]);
      expect(await store.get(task.id)).toMatchObject({ status: "backlog" });
    });

    it("treats a dependency id absent from the store as unmet, not as satisfied", async () => {
      const task = makeTask({ id: "T-0001", depends_on: ["T-9999"] });
      await store.create(task);

      await expect(
        store.update(task.id, { status: "ready" }, { requireDependenciesSatisfied: true })
      ).rejects.toThrow(DependencyNotSatisfiedError);
      expect(await store.get(task.id)).toMatchObject({ status: "backlog" });
    });

    it("writes normally when requireDependenciesSatisfied is not set at all, even with an unmet dependency (opt-in, backward compatible)", async () => {
      await store.create(makeTask({ id: "T-0090", status: "backlog" }));
      const task = makeTask({ id: "T-0001", depends_on: ["T-0090"] });
      await store.create(task);

      const updated = await store.update(task.id, { status: "ready" });
      expect(updated.status).toBe("ready");
    });

    it("combines with `expected`: a fingerprint mismatch is still reported as StaleWriteError, not swallowed by the dependency check", async () => {
      await store.create(makeTask({ id: "T-0090", status: "done" }));
      const task = makeTask({ id: "T-0001", depends_on: ["T-0090"], agent: "infra" });
      await store.create(task);
      await store.update(task.id, { agent: "server" });

      await expect(
        store.update(
          task.id,
          { status: "ready" },
          { expected: { agent: "infra" }, requireDependenciesSatisfied: true }
        )
      ).rejects.toThrow(StaleWriteError);
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
