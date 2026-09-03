import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { runMigrations } from "../src/lib/db/migrate.js";

// T-0301: 0004 widens the tasks.agent CHECK constraint, and SQLite has no ALTER TABLE for
// CHECK -- so like 0002 it must rebuild the table (CREATE/copy/DROP/RENAME).
//
// That DROP is the hazard PR #182 hit: task_dependencies, comments and attachments all
// REFERENCE tasks(id) ON DELETE CASCADE, so with `PRAGMA foreign_keys` left ON the DROP
// performs an implicit cascading DELETE and silently wipes every child row before the RENAME
// restores the `tasks` name. migrate.js toggles the pragma OFF around each migration for
// exactly this reason; this test proves that protection actually holds for 0004 rather than
// trusting it, by seeding a fully-populated schema at 0003 and then applying 0004 alone.

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/lib/db/migrations"
);

let tmpDir;
let db;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-0004-dataloss-"));
  db = new Database(path.join(tmpDir, "test.db"));
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Runs only the migrations before 0004, by copying them into an isolated dir. */
async function migrateToPre0004() {
  const staged = path.join(tmpDir, "migrations-pre-0004");
  await fs.mkdir(staged, { recursive: true });
  const all = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const pre = all.filter((f) => f < "0004");
  expect(pre.length).toBeGreaterThan(0);
  for (const f of pre) {
    await fs.copyFile(path.join(MIGRATIONS_DIR, f), path.join(staged, f));
  }
  runMigrations(db, staged);
  return pre;
}

function seed() {
  db.prepare(
    "INSERT INTO tasks (id, title, status, priority, phase, agent, created, branch, commit_sha, pr, " +
      "deliverable_type, attempts, body, requires_approval, approved_by, approved_at) " +
      "VALUES ('T-0001','Parent','blocked','P0',6,'assets','2026-08-01','feature/T-0001','abc123'," +
      "'https://example.invalid/pr/1','artifact',5,'## Context\nbody text',1,'@DennieSeth','2026-09-01')"
  ).run();
  db.prepare(
    "INSERT INTO tasks (id, title, status, priority, phase, agent, created) " +
      "VALUES ('T-0002','Null agent card','backlog','P2',1,NULL,'2026-08-02')"
  ).run();
  db.prepare("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES ('T-0001','T-0002')").run();
  db.prepare(
    "INSERT INTO comments (task_id, author, text, created_at) " +
      "VALUES ('T-0001','assembled-board','a blocker report','2026-09-01T00:00:00.000Z')"
  ).run();
  db.prepare(
    "INSERT INTO attachments (task_id, filename, size, mimetype, uploaded_by, uploaded_at) " +
      "VALUES ('T-0001','sheet.png',2647,'image/png','agent','2026-09-01T00:00:00.000Z')"
  ).run();
  db.prepare(
    "INSERT INTO card_events (task_id, action, changed, actor, created_at) " +
      "VALUES ('T-0001','update','[\"status\"]','system','2026-09-01T00:00:00.000Z')"
  ).run();
}

const counts = () =>
  Object.fromEntries(
    ["tasks", "task_dependencies", "comments", "attachments", "card_events"].map((t) => [
      t,
      db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
    ])
  );

describe("migration 0004 preserves all data (T-0301, PR #182 FK-cascade hazard)", () => {
  it("keeps every task row and every child row across the table rebuild", async () => {
    await migrateToPre0004();
    seed();
    const before = counts();
    const tasksBefore = db.prepare("SELECT * FROM tasks ORDER BY id").all();

    runMigrations(db, MIGRATIONS_DIR); // applies 0004 on top

    expect(counts()).toEqual(before);
    // the child tables are the ones a cascading DROP would have silently emptied
    expect(counts().task_dependencies).toBe(1);
    expect(counts().comments).toBe(1);
    expect(counts().attachments).toBe(1);
    // every column value survives byte-for-byte, including the 0003 approval columns
    expect(db.prepare("SELECT * FROM tasks ORDER BY id").all()).toEqual(tasksBefore);
  });

  it("leaves foreign_keys enforcement back ON afterwards, and cascade still works", async () => {
    await migrateToPre0004();
    seed();
    db.pragma("foreign_keys = ON");

    runMigrations(db, MIGRATIONS_DIR);

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    // the FK relationship is intact on the rebuilt table: deleting the parent cascades
    db.prepare("DELETE FROM tasks WHERE id = 'T-0001'").run();
    expect(counts().comments).toBe(0);
    expect(counts().attachments).toBe(0);
    expect(counts().task_dependencies).toBe(0);
  });

  it("is idempotent -- re-running migrations does not rebuild or lose anything", async () => {
    await migrateToPre0004();
    seed();
    runMigrations(db, MIGRATIONS_DIR);
    const after = counts();

    expect(() => runMigrations(db, MIGRATIONS_DIR)).not.toThrow();
    expect(counts()).toEqual(after);
  });
});
