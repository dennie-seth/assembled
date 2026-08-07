import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, DEFAULT_DB_PATH } from "../src/lib/db/connection.js";

let tmpDir;
let db;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-dbconn-"));
});

afterEach(async () => {
  if (db) {
    db.close();
    db = undefined;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("openDb", () => {
  it("creates the parent directory for the db file if it doesn't exist", async () => {
    const dbPath = path.join(tmpDir, "nested", "dir", "board.db");
    db = openDb(dbPath);
    expect(await fs.access(path.join(tmpDir, "nested", "dir")).then(() => true)).toBe(true);
    expect(await fs.access(dbPath).then(() => true)).toBe(true);
  });

  it("enables WAL journal mode", () => {
    db = openDb(path.join(tmpDir, "board.db"));
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("sets synchronous = FULL for maximum durability", () => {
    db = openDb(path.join(tmpDir, "board.db"));
    // SQLite reports synchronous as an integer: 0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA
    expect(db.pragma("synchronous", { simple: true })).toBe(2);
  });

  it("enables foreign key enforcement", () => {
    db = openDb(path.join(tmpDir, "board.db"));
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("sets a non-zero busy_timeout so concurrent access waits instead of failing immediately", () => {
    db = openDb(path.join(tmpDir, "board.db"));
    expect(db.pragma("busy_timeout", { simple: true })).toBeGreaterThan(0);
  });

  it("runs migrations so the schema is ready to use immediately", () => {
    db = openDb(path.join(tmpDir, "board.db"));
    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tableNames).toContain("tasks");
    expect(tableNames).toContain("card_events");
  });

  it("foreign key enforcement actually rejects an orphaned child row", () => {
    db = openDb(path.join(tmpDir, "board.db"));
    expect(() =>
      db
        .prepare("INSERT INTO comments (task_id, author, text, created_at) VALUES (?, ?, ?, ?)")
        .run("T-9999", "someone", "hi", new Date().toISOString())
    ).toThrow(/foreign key/i);
  });

  it("exports a default db path under ~/.local/share/assembled-board", () => {
    expect(DEFAULT_DB_PATH).toMatch(/[/\\]\.local[/\\]share[/\\]assembled-board[/\\]board\.db$/);
  });
});
