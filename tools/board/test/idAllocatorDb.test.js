import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/lib/db/connection.js";
import { IdAllocatorDb } from "../src/lib/db/idAllocatorDb.js";
import { DbTaskStore } from "../src/lib/db/dbTaskStore.js";
import { makeTask } from "./taskStoreContract.js";

let tmpDir;
let dbPath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-idallocdb-"));
  dbPath = path.join(tmpDir, "board.db");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("IdAllocatorDb", () => {
  it("allocates T-0001 from a freshly migrated database", async () => {
    const db = openDb(dbPath);
    const allocator = new IdAllocatorDb(db);
    expect(await allocator.allocate()).toBe("T-0001");
    db.close();
  });

  it("allocates sequential ids across successive calls", async () => {
    const db = openDb(dbPath);
    const allocator = new IdAllocatorDb(db);
    expect(await allocator.allocate()).toBe("T-0001");
    expect(await allocator.allocate()).toBe("T-0002");
    expect(await allocator.allocate()).toBe("T-0003");
    db.close();
  });

  it("persists allocation state across separate IdAllocatorDb instances sharing a db file", async () => {
    const dbA = openDb(dbPath);
    const allocatorA = new IdAllocatorDb(dbA);
    await allocatorA.allocate();
    await allocatorA.allocate();
    dbA.close();

    const dbB = openDb(dbPath);
    const allocatorB = new IdAllocatorDb(dbB);
    expect(await allocatorB.allocate()).toBe("T-0003");
    dbB.close();
  });

  it("never reuses an id after its task row is deleted", async () => {
    const db = openDb(dbPath);
    const allocator = new IdAllocatorDb(db);
    const store = new DbTaskStore(db);

    const first = await allocator.allocate();
    const second = await allocator.allocate();
    await store.create(makeTask({ id: second }));
    await store.remove(second);

    const third = await allocator.allocate();
    expect(third).toBe("T-0003");
    expect(new Set([first, second, third]).size).toBe(3);
    db.close();
  });

  it("allocates unique, sequential ids under concurrent calls", async () => {
    const db = openDb(dbPath);
    const allocator = new IdAllocatorDb(db);
    const ids = await Promise.all(Array.from({ length: 25 }, () => allocator.allocate()));

    expect(new Set(ids).size).toBe(25);
    const expected = Array.from({ length: 25 }, (_, i) => `T-${String(i + 1).padStart(4, "0")}`);
    expect([...ids].sort()).toEqual(expected);
    db.close();
  });

  it("accepts a db file path directly, opening it with migrations applied", async () => {
    const allocator = new IdAllocatorDb(dbPath);
    expect(await allocator.allocate()).toBe("T-0001");
    allocator.close();
  });
});
