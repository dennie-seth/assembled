import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/lib/db/connection.js";
import { DbTaskStore } from "../src/lib/db/dbTaskStore.js";
import { backupDb } from "../src/lib/db/backup.js";
import { makeTask } from "./taskStoreContract.js";

let tmpDir;
let dbPath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-dbbackup-"));
  dbPath = path.join(tmpDir, "board.db");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("backupDb", () => {
  it("produces a file at the destination path", async () => {
    const db = openDb(dbPath);
    const destPath = path.join(tmpDir, "board.bak");
    await backupDb(db, destPath);
    expect(await fs.access(destPath).then(() => true)).toBe(true);
    db.close();
  });

  it("captures data written before the backup, including WAL-only (not yet checkpointed) writes", async () => {
    const db = openDb(dbPath);
    const store = new DbTaskStore(db);
    await store.create(makeTask({ id: "T-0001" }));
    await store.create(makeTask({ id: "T-0002" }));

    const destPath = path.join(tmpDir, "board.bak");
    await backupDb(db, destPath);
    db.close();

    const restored = new Database(destPath, { readonly: true });
    const ids = restored.prepare("SELECT id FROM tasks ORDER BY id").all().map((r) => r.id);
    expect(ids).toEqual(["T-0001", "T-0002"]);
    restored.close();
  });

  it("the produced backup is a fully independent, restorable copy usable by DbTaskStore", async () => {
    const db = openDb(dbPath);
    const store = new DbTaskStore(db);
    const task = makeTask({
      comments: [{ author: "Dennie", text: "hi", timestamp: "2026-08-05T12:00:00.000Z" }],
      attachments: [
        {
          filename: "a.png",
          size: 10,
          mimetype: "image/png",
          uploaded_by: "Dennie",
          uploaded_at: "2026-08-05T12:00:00.000Z"
        }
      ]
    });
    await store.create(task);

    const destPath = path.join(tmpDir, "board.bak");
    await backupDb(db, destPath);
    db.close();

    // "restore" = point a fresh store at the backup file directly, exactly what an operator
    // would do: cp the .bak over the live path (or BOARD_DB_PATH=<bak> for a throwaway check).
    const restoredStore = new DbTaskStore(destPath);
    expect(await restoredStore.get(task.id)).toEqual(task);
    restoredStore.close();
  });

  it("never mutates the live database it's backing up", async () => {
    const db = openDb(dbPath);
    const store = new DbTaskStore(db);
    await store.create(makeTask({ id: "T-0001" }));

    const destPath = path.join(tmpDir, "board.bak");
    await backupDb(db, destPath);

    // the source connection is still fully usable afterward
    await store.create(makeTask({ id: "T-0002" }));
    expect((await store.list()).map((t) => t.id)).toEqual(["T-0001", "T-0002"]);
    db.close();
  });
});
