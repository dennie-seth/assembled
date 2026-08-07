import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/lib/db/connection.js";
import { DbTaskStore } from "../src/lib/db/dbTaskStore.js";
import { runTaskStoreContractTests, makeTask } from "./taskStoreContract.js";

async function makeTmpDbStore() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-dbtaskstore-"));
  const db = openDb(path.join(tmpDir, "board.db"));
  return {
    db,
    tmpDir,
    store: new DbTaskStore(db),
    dispose: async () => {
      db.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  };
}

runTaskStoreContractTests("DbTaskStore", makeTmpDbStore);

describe("DbTaskStore construction", () => {
  it("accepts a db file path directly, opening it with durability pragmas + migrations applied", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-dbtaskstore-path-"));
    try {
      const store = new DbTaskStore(path.join(tmpDir, "board.db"));
      const task = makeTask();
      await store.create(task);
      expect(await store.get(task.id)).toEqual(task);
      store.close();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("DbTaskStore card_events audit trail", () => {
  it("records a create event with the full set of task fields", async () => {
    const { db, store, dispose } = await makeTmpDbStore();
    try {
      const task = makeTask();
      await store.create(task, { actor: "tester" });

      const events = db.prepare("SELECT * FROM card_events WHERE task_id = ?").all(task.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ task_id: task.id, action: "create", actor: "tester" });
      expect(JSON.parse(events[0].changed)).toEqual(expect.arrayContaining(["title", "status"]));
      expect(events[0].created_at).toBeTruthy();
    } finally {
      await dispose();
    }
  });

  it("records an update event listing only the changed field names", async () => {
    const { db, store, dispose } = await makeTmpDbStore();
    try {
      const task = makeTask();
      await store.create(task);
      await store.update(task.id, { status: "ready", title: "Renamed" }, { actor: "tester" });

      const events = db
        .prepare("SELECT * FROM card_events WHERE task_id = ? AND action = 'update'")
        .all(task.id);
      expect(events).toHaveLength(1);
      expect(events[0].actor).toBe("tester");
      expect(JSON.parse(events[0].changed).sort()).toEqual(["status", "title"]);
    } finally {
      await dispose();
    }
  });

  it("defaults actor to 'system' when not provided", async () => {
    const { db, store, dispose } = await makeTmpDbStore();
    try {
      const task = makeTask();
      await store.create(task);
      const events = db.prepare("SELECT actor FROM card_events WHERE task_id = ?").all(task.id);
      expect(events[0].actor).toBe("system");
    } finally {
      await dispose();
    }
  });

  it("records a move event as an update with only status changed", async () => {
    const { db, store, dispose } = await makeTmpDbStore();
    try {
      const task = makeTask();
      await store.create(task);
      await store.move(task.id, "in-progress");
      const events = db
        .prepare("SELECT * FROM card_events WHERE task_id = ? AND action != 'create'")
        .all(task.id);
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0].changed)).toEqual(["status"]);
    } finally {
      await dispose();
    }
  });

  it("records a remove event and survives the task's own deletion (not FK'd to tasks)", async () => {
    const { db, store, dispose } = await makeTmpDbStore();
    try {
      const task = makeTask();
      await store.create(task);
      await store.remove(task.id);

      const events = db
        .prepare("SELECT * FROM card_events WHERE task_id = ? ORDER BY id ASC")
        .all(task.id);
      expect(events.map((e) => e.action)).toEqual(["create", "remove"]);
      // the task row is gone, but its audit trail is still fully queryable
      expect(db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id)).toBeUndefined();
    } finally {
      await dispose();
    }
  });
});

describe("DbTaskStore durability", () => {
  it("opens its connection in WAL mode", async () => {
    const { db, dispose } = await makeTmpDbStore();
    try {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      await dispose();
    }
  });

  it("wraps a multi-table create in a single transaction -- a failure leaves nothing behind", async () => {
    const { db, store, dispose } = await makeTmpDbStore();
    try {
      const task = makeTask({
        attachments: [
          {
            filename: "a.png",
            size: 10,
            mimetype: "image/png",
            uploaded_by: "Dennie",
            uploaded_at: "2026-08-05T12:00:00.000Z"
          },
          {
            // duplicate filename violates the (task_id, filename) UNIQUE constraint --
            // the whole create must roll back, not leave a partial row behind
            filename: "a.png",
            size: 20,
            mimetype: "image/png",
            uploaded_by: "Dennie",
            uploaded_at: "2026-08-05T12:01:00.000Z"
          }
        ]
      });

      await expect(store.create(task)).rejects.toThrow();
      expect(db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id)).toBeUndefined();
      expect(db.prepare("SELECT * FROM card_events WHERE task_id = ?").all(task.id)).toEqual([]);
    } finally {
      await dispose();
    }
  });
});
