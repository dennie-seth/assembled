import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { runMigrations } from "../src/lib/db/migrate.js";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/lib/db/migrations"
);

let tmpDir;
let db;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-dbmigrate-"));
  db = new Database(path.join(tmpDir, "test.db"));
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runMigrations", () => {
  it("applies every .sql file in the migrations dir and creates the target tables", () => {
    runMigrations(db, MIGRATIONS_DIR);

    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);

    for (const expected of [
      "tasks",
      "task_dependencies",
      "comments",
      "attachments",
      "card_events",
      "id_allocator",
      "schema_migrations"
    ]) {
      expect(tableNames).toContain(expected);
    }
  });

  it("seeds a single id_allocator row at next_seq = 0", () => {
    runMigrations(db, MIGRATIONS_DIR);
    const rows = db.prepare("SELECT next_seq FROM id_allocator").all();
    expect(rows).toEqual([{ next_seq: 0 }]);
  });

  it("is idempotent -- running twice does not re-apply or error", () => {
    runMigrations(db, MIGRATIONS_DIR);
    expect(() => runMigrations(db, MIGRATIONS_DIR)).not.toThrow();
    const rows = db.prepare("SELECT next_seq FROM id_allocator").all();
    expect(rows).toEqual([{ next_seq: 0 }]);
  });

  it("records each applied migration file in schema_migrations", () => {
    runMigrations(db, MIGRATIONS_DIR);
    const ids = db.prepare("SELECT id FROM schema_migrations ORDER BY id").all().map((r) => r.id);
    expect(ids).toEqual([
      "0001_init.sql",
      "0002_add_generic_agent.sql",
      "0003_add_approval_gate.sql",
      "0004_add_dispatch_agent.sql"
    ]);
  });
});

describe("0002_add_generic_agent.sql", () => {
  function insertTask(id, agent) {
    db.prepare(
      `INSERT INTO tasks (id, title, status, priority, phase, agent, created, deliverable_type, attempts, body)
       VALUES (?, 'Task', 'backlog', 'P2', 0, ?, '2026-08-01', 'code', 0, '')`
    ).run(id, agent);
  }

  it("accepts 'generic' as a legal agent value after the rebuild", () => {
    runMigrations(db, MIGRATIONS_DIR);
    expect(() => insertTask("T-0001", "generic")).not.toThrow();
    expect(db.prepare("SELECT agent FROM tasks WHERE id = ?").get("T-0001").agent).toBe("generic");
  });

  it("still accepts a null agent after the rebuild", () => {
    runMigrations(db, MIGRATIONS_DIR);
    expect(() => insertTask("T-0001", null)).not.toThrow();
  });

  it("still rejects an unrecognized agent value after the rebuild", () => {
    runMigrations(db, MIGRATIONS_DIR);
    expect(() => insertTask("T-0001", "designer")).toThrow(/CHECK/);
  });

  it("preserves existing rows -- including dependent task_dependencies/comments/attachments rows -- when 0002 is applied to a db that already has 0001-era data (the real upgrade path)", async () => {
    // Simulate the real deployment: a db that only has 0001 applied and already has live data,
    // then a later run of runMigrations() picks up the new 0002 file.
    const only0001Dir = path.join(tmpDir, "only-0001");
    await fs.mkdir(only0001Dir);
    await fs.copyFile(path.join(MIGRATIONS_DIR, "0001_init.sql"), path.join(only0001Dir, "0001_init.sql"));
    runMigrations(db, only0001Dir);

    db.prepare(
      `INSERT INTO tasks (id, title, status, priority, phase, agent, created, deliverable_type, attempts, body)
       VALUES ('T-0001', 'Pre-existing card', 'backlog', 'P2', 0, 'infra', '2026-08-01', 'code', 0, 'body text')`
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, status, priority, phase, agent, created, deliverable_type, attempts, body)
       VALUES ('T-0002', 'Dependency', 'backlog', 'P2', 0, 'server', '2026-08-01', 'code', 0, '')`
    ).run();
    db.prepare("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES ('T-0001', 'T-0002')").run();
    db.prepare(
      "INSERT INTO comments (task_id, author, text, created_at) VALUES ('T-0001', 'Dennie', 'hi', '2026-08-01T00:00:00.000Z')"
    ).run();
    db.prepare(
      "INSERT INTO attachments (task_id, filename, size, mimetype, uploaded_by, uploaded_at) VALUES ('T-0001', 'a.png', 10, 'image/png', 'Dennie', '2026-08-01T00:00:00.000Z')"
    ).run();

    // Now apply the real, full migrations dir -- 0002 rebuilds `tasks` under this existing data.
    runMigrations(db, MIGRATIONS_DIR);

    const task = db.prepare("SELECT * FROM tasks WHERE id = 'T-0001'").get();
    expect(task.title).toBe("Pre-existing card");
    expect(task.agent).toBe("infra");
    expect(task.body).toBe("body text");
    expect(db.prepare("SELECT depends_on_id FROM task_dependencies WHERE task_id = 'T-0001'").all()).toEqual([
      { depends_on_id: "T-0002" }
    ]);
    expect(db.prepare("SELECT text FROM comments WHERE task_id = 'T-0001'").all()).toEqual([{ text: "hi" }]);
    expect(db.prepare("SELECT filename FROM attachments WHERE task_id = 'T-0001'").all()).toEqual([
      { filename: "a.png" }
    ]);

    // The CHECK constraint is genuinely widened post-rebuild, not just tolerant of pre-existing rows.
    expect(() => insertTask("T-0003", "generic")).not.toThrow();

    // Deleting the dependency (T-0002) still cascades to its child rows, proving the rebuilt
    // table's FK/CASCADE wiring survived, not just the raw data.
    db.prepare("DELETE FROM tasks WHERE id = 'T-0001'").run();
    expect(db.prepare("SELECT * FROM task_dependencies WHERE task_id = 'T-0001'").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM comments WHERE task_id = 'T-0001'").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM attachments WHERE task_id = 'T-0001'").all()).toEqual([]);
  });
});

describe("0004_add_dispatch_agent.sql", () => {
  function insertTask(id, agent) {
    db.prepare(
      `INSERT INTO tasks (id, title, status, priority, phase, agent, created, deliverable_type, attempts, body)
       VALUES (?, 'Task', 'backlog', 'P2', 0, ?, '2026-08-01', 'code', 0, '')`
    ).run(id, agent);
  }

  it("accepts 'dispatch' as a legal agent value after the rebuild -- the escalation sentinel taskParser.js's ASSIGNABLE_AGENT_NAMES already carries", () => {
    runMigrations(db, MIGRATIONS_DIR);
    expect(() => insertTask("T-0001", "dispatch")).not.toThrow();
    expect(db.prepare("SELECT agent FROM tasks WHERE id = ?").get("T-0001").agent).toBe("dispatch");
  });

  it("still accepts every value 0002 already widened for (e.g. 'generic') -- the rebuild only adds 'dispatch', it doesn't narrow anything", () => {
    runMigrations(db, MIGRATIONS_DIR);
    expect(() => insertTask("T-0001", "generic")).not.toThrow();
  });

  it("still accepts a null agent after the rebuild", () => {
    runMigrations(db, MIGRATIONS_DIR);
    expect(() => insertTask("T-0001", null)).not.toThrow();
  });

  it("still rejects an unrecognized agent value after the rebuild", () => {
    runMigrations(db, MIGRATIONS_DIR);
    expect(() => insertTask("T-0001", "designer")).toThrow(/CHECK/);
  });

  it("preserves existing rows -- including the 0003 approval-gate columns and dependent task_dependencies/comments/attachments rows -- when 0004 is applied to a db that already has 0001-0003 data (the real upgrade path)", async () => {
    // Simulate the real deployment: a db that only has 0001-0003 applied and already has live
    // data, then a later run of runMigrations() picks up the new 0004 file. This is exactly the
    // FK-cascade-on-DROP hazard from the generic-default-agent work (PR #182, see 0002's own
    // docstring and migrate.js's runMigrations docstring) -- 0004 rebuilds the same table again.
    const only0001to0003Dir = path.join(tmpDir, "only-0001-to-0003");
    await fs.mkdir(only0001to0003Dir);
    for (const file of ["0001_init.sql", "0002_add_generic_agent.sql", "0003_add_approval_gate.sql"]) {
      await fs.copyFile(path.join(MIGRATIONS_DIR, file), path.join(only0001to0003Dir, file));
    }
    runMigrations(db, only0001to0003Dir);

    db.prepare(
      `INSERT INTO tasks (id, title, status, priority, phase, agent, created, deliverable_type,
                          requires_approval, approved_by, approved_at, attempts, body)
       VALUES ('T-0001', 'Pre-existing card', 'backlog', 'P2', 0, 'infra', '2026-08-01', 'code',
               1, 'Dennie', '2026-08-15T00:00:00.000Z', 0, 'body text')`
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, status, priority, phase, agent, created, deliverable_type, attempts, body)
       VALUES ('T-0002', 'Dependency', 'backlog', 'P2', 0, 'server', '2026-08-01', 'code', 0, '')`
    ).run();
    db.prepare("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES ('T-0001', 'T-0002')").run();
    db.prepare(
      "INSERT INTO comments (task_id, author, text, created_at) VALUES ('T-0001', 'Dennie', 'hi', '2026-08-01T00:00:00.000Z')"
    ).run();
    db.prepare(
      "INSERT INTO attachments (task_id, filename, size, mimetype, uploaded_by, uploaded_at) VALUES ('T-0001', 'a.png', 10, 'image/png', 'Dennie', '2026-08-01T00:00:00.000Z')"
    ).run();

    // Now apply the real, full migrations dir -- 0004 rebuilds `tasks` under this existing data.
    runMigrations(db, MIGRATIONS_DIR);

    const task = db.prepare("SELECT * FROM tasks WHERE id = 'T-0001'").get();
    expect(task.title).toBe("Pre-existing card");
    expect(task.agent).toBe("infra");
    expect(task.body).toBe("body text");
    expect(task.requires_approval).toBe(1);
    expect(task.approved_by).toBe("Dennie");
    expect(task.approved_at).toBe("2026-08-15T00:00:00.000Z");
    expect(db.prepare("SELECT depends_on_id FROM task_dependencies WHERE task_id = 'T-0001'").all()).toEqual([
      { depends_on_id: "T-0002" }
    ]);
    expect(db.prepare("SELECT text FROM comments WHERE task_id = 'T-0001'").all()).toEqual([{ text: "hi" }]);
    expect(db.prepare("SELECT filename FROM attachments WHERE task_id = 'T-0001'").all()).toEqual([
      { filename: "a.png" }
    ]);

    // The CHECK constraint is genuinely widened post-rebuild, not just tolerant of pre-existing rows.
    expect(() => insertTask("T-0003", "dispatch")).not.toThrow();

    // Deleting the dependency (T-0002) still cascades to its child rows, proving the rebuilt
    // table's FK/CASCADE wiring survived, not just the raw data.
    db.prepare("DELETE FROM tasks WHERE id = 'T-0001'").run();
    expect(db.prepare("SELECT * FROM task_dependencies WHERE task_id = 'T-0001'").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM comments WHERE task_id = 'T-0001'").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM attachments WHERE task_id = 'T-0001'").all()).toEqual([]);
  });
});
