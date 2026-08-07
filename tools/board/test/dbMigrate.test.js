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
    expect(ids).toEqual(["0001_init.sql"]);
  });
});
