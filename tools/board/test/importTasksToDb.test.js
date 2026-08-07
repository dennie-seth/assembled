import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { DbTaskStore } from "../src/lib/db/dbTaskStore.js";
import { importTasks } from "../src/lib/db/importer.js";
import { makeTask } from "./taskStoreContract.js";

let tmpDir;
let tasksDir;
let dbPath;
let dataDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-importer-"));
  tasksDir = path.join(tmpDir, "tasks");
  dbPath = path.join(tmpDir, "db", "board.db");
  dataDir = path.join(tmpDir, "data");
  await fs.mkdir(tasksDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seedSourceTasks() {
  const fsStore = new FsTaskStore(tasksDir);
  const t1 = makeTask({
    id: "T-0001",
    comments: [{ author: "Dennie", text: "hi", timestamp: "2026-08-05T12:00:00.000Z" }]
  });
  const t2 = makeTask({
    id: "T-0002",
    depends_on: ["T-0001"],
    attachments: [
      {
        filename: "reference.png",
        size: 4,
        mimetype: "image/png",
        uploaded_by: "Dennie",
        uploaded_at: "2026-08-05T12:00:00.000Z"
      }
    ]
  });
  await fsStore.create(t1);
  await fsStore.create(t2);

  const attachDir = path.join(tasksDir, "attachments", "T-0002");
  await fs.mkdir(attachDir, { recursive: true });
  await fs.writeFile(path.join(attachDir, "reference.png"), Buffer.from("PNG!"));

  return { t1, t2 };
}

describe("importTasks dry-run", () => {
  it("reports counts without writing a db file", async () => {
    await seedSourceTasks();
    const report = await importTasks({ tasksDir, dbPath, dataDir, commit: false });

    expect(report.ok).toBe(true);
    expect(report.taskCount).toBe(2);
    expect(report.commentCount).toBe(1);
    expect(report.attachmentCount).toBe(1);
    expect(report.attachmentTotalBytes).toBe(4);
    expect(report.errors).toEqual([]);
    expect(await fs.access(dbPath).then(() => true, () => false)).toBe(false);
  });

  it("aborts and reports errors instead of partially importing a malformed card, without writing", async () => {
    await seedSourceTasks();
    await fs.writeFile(path.join(tasksDir, "T-0003.md"), "not a valid task file at all", "utf8");

    const report = await importTasks({ tasksDir, dbPath, dataDir, commit: false });

    expect(report.ok).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(await fs.access(dbPath).then(() => true, () => false)).toBe(false);
  });

  it("aborts when an attachment's frontmatter metadata has no matching file on disk", async () => {
    await seedSourceTasks();
    await fs.rm(path.join(tasksDir, "attachments", "T-0002", "reference.png"));

    const report = await importTasks({ tasksDir, dbPath, dataDir, commit: false });

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => /reference\.png/.test(e.message))).toBe(true);
  });

  it("never mutates the source tasks dir", async () => {
    await seedSourceTasks();
    const before = await fs.readdir(tasksDir, { recursive: true });
    await importTasks({ tasksDir, dbPath, dataDir, commit: false });
    const after = await fs.readdir(tasksDir, { recursive: true });
    expect([...after].sort()).toEqual([...before].sort());
  });
});

describe("importTasks --commit", () => {
  it("round-trips: DbTaskStore reads back exactly what FsTaskStore reads from the same source", async () => {
    const { t1, t2 } = await seedSourceTasks();
    const report = await importTasks({ tasksDir, dbPath, dataDir, commit: true });
    expect(report.ok).toBe(true);

    const fsStore = new FsTaskStore(tasksDir);
    const dbStore = new DbTaskStore(dbPath);
    try {
      for (const expected of [t1, t2]) {
        const fromFs = await fsStore.get(expected.id);
        const fromDb = await dbStore.get(expected.id);
        expect(fromDb).toEqual(fromFs);
      }
      expect((await dbStore.list()).map((t) => t.id)).toEqual(
        (await fsStore.list()).map((t) => t.id)
      );
    } finally {
      dbStore.close();
    }
  });

  it("copies attachment files (not moves) into <dataDir>/attachments/<id>/", async () => {
    await seedSourceTasks();
    await importTasks({ tasksDir, dbPath, dataDir, commit: true });

    const copied = path.join(dataDir, "attachments", "T-0002", "reference.png");
    expect(await fs.readFile(copied)).toEqual(Buffer.from("PNG!"));
    // copy, not move -- source is untouched
    const original = path.join(tasksDir, "attachments", "T-0002", "reference.png");
    expect(await fs.readFile(original)).toEqual(Buffer.from("PNG!"));
  });

  it("never mutates the source tasks dir", async () => {
    await seedSourceTasks();
    const before = await fs.readdir(tasksDir, { recursive: true });
    await importTasks({ tasksDir, dbPath, dataDir, commit: true });
    const after = await fs.readdir(tasksDir, { recursive: true });
    expect([...after].sort()).toEqual([...before].sort());
  });

  it("seeds the id allocator to the max imported task id", async () => {
    await seedSourceTasks();
    await importTasks({ tasksDir, dbPath, dataDir, commit: true });

    const dbStore = new DbTaskStore(dbPath);
    const { IdAllocatorDb } = await import("../src/lib/db/idAllocatorDb.js");
    const allocator = new IdAllocatorDb(dbStore.db);
    try {
      expect(await allocator.allocate()).toBe("T-0003");
    } finally {
      dbStore.close();
    }
  });

  it("backs up a pre-existing db file to a timestamped .bak path before writing, never overwriting in place", async () => {
    await seedSourceTasks();
    await importTasks({ tasksDir, dbPath, dataDir, commit: true });

    // re-run against the same (now populated) db path with a fresh, disjoint source task
    const secondTasksDir = path.join(tmpDir, "tasks2");
    await fs.mkdir(secondTasksDir, { recursive: true });
    await new FsTaskStore(secondTasksDir).create(makeTask({ id: "T-0009" }));

    await importTasks({ tasksDir: secondTasksDir, dbPath, dataDir, commit: true });

    const dbDirEntries = await fs.readdir(path.dirname(dbPath));
    const backups = dbDirEntries.filter((f) => f.startsWith(path.basename(dbPath) + ".bak-"));
    expect(backups.length).toBe(1);

    // the backup captured the state *before* the second import (T-0001/T-0002, not T-0009)
    const backupStore = new DbTaskStore(path.join(path.dirname(dbPath), backups[0]));
    try {
      expect((await backupStore.list()).map((t) => t.id).sort()).toEqual(["T-0001", "T-0002"]);
    } finally {
      backupStore.close();
    }
  });

  it("aborts (fail-closed) and writes nothing when the backlog itself is invalid", async () => {
    await seedSourceTasks();
    await fs.writeFile(path.join(tasksDir, "T-0003.md"), "not a valid task file at all", "utf8");

    const report = await importTasks({ tasksDir, dbPath, dataDir, commit: true });

    expect(report.ok).toBe(false);
    expect(await fs.access(dbPath).then(() => true, () => false)).toBe(false);
  });
});
