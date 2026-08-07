import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrate.js";

// Deliberately NOT derived from import.meta.url/repoRoot the way DEFAULT_TASKS_DIR is --
// this repo runs the same logical board from many independent git worktrees at once, and a
// path inside any one of them would silently fork the database per worktree. See
// docs/design/cards-to-database.md, "Where the DB file lives".
export const DEFAULT_DB_PATH = path.join(os.homedir(), ".local", "share", "assembled-board", "board.db");

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations"
);

/** Applies this store's durability posture. Safe to call on every connection open. */
export function applyPragmas(db) {
  db.pragma("journal_mode = WAL");
  // FULL (not NORMAL): "we need max stability" is an explicit requirement for this refactor
  // (docs/design/cards-to-database.md's whole premise is fixing durability/drift bugs the
  // git-coupled model had), so this trades a small amount of write throughput -- irrelevant
  // for a single-user local tool -- for fsync-on-every-transaction-commit durability even
  // against an OS crash/power loss, not just an application crash.
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

/**
 * Opens (creating if needed) the board database at `dbPath`, applies durability pragmas, and
 * brings the schema up to date. `dbPath` defaults to `BOARD_DB_PATH` env var, then
 * `DEFAULT_DB_PATH` -- the same override pattern as `BOARD_TASKS_DIR`/`BOARD_PORT`.
 */
export function openDb(dbPath = process.env.BOARD_DB_PATH || DEFAULT_DB_PATH) {
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  applyPragmas(db);
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

/**
 * Resolves the db file path without opening it -- same BOARD_DB_PATH -> DEFAULT_DB_PATH
 * override chain as openDb(). Used to derive the db-mode attachments root
 * (`<dirname(dbPath)>/attachments/`, see docs/design/cards-to-database.md's "Attachments stay
 * files on disk") without needing an extra env var of its own.
 */
export function resolveDbPath(dbPath = process.env.BOARD_DB_PATH || DEFAULT_DB_PATH) {
  return dbPath;
}
