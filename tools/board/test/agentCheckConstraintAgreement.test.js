import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { runMigrations } from "../src/lib/db/migrate.js";
import { ASSIGNABLE_AGENT_NAMES } from "../src/lib/taskParser.js";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/lib/db/migrations"
);

let tmpDir;
let db;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-agent-check-agreement-"));
  db = new Database(path.join(tmpDir, "test.db"));
  runMigrations(db, MIGRATIONS_DIR);
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Reads the live `agent IN (...)` CHECK constraint values straight off the migrated schema
 * (sqlite_master's stored CREATE TABLE text) -- not a third hard-coded copy of the list. This is
 * the guard T-0301 asks for: taskParser.js's ASSIGNABLE_AGENT_NAMES and the SQLite schema are two
 * independently-maintained lists (escalation's "dispatch" sentinel was added to one and not the
 * other, silently killing db-mode escalation), so this test fails loudly the moment they diverge
 * again in either direction.
 */
function readAgentCheckConstraintValues(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
    .get();
  const match = /agent\s+TEXT\s+CHECK\s*\(\s*agent\s+IN\s*\(([^)]*)\)/.exec(row.sql);
  if (!match) {
    throw new Error("Could not find the tasks.agent CHECK constraint in the migrated schema");
  }
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, ""));
}

describe("tasks.agent CHECK constraint agrees with taskParser.ASSIGNABLE_AGENT_NAMES", () => {
  it("accepts exactly the same set of agent names the schema's CHECK constraint allows", () => {
    const constraintValues = readAgentCheckConstraintValues(db);
    expect(new Set(constraintValues)).toEqual(new Set(ASSIGNABLE_AGENT_NAMES));
  });

  it("accepts every ASSIGNABLE_AGENT_NAMES value as a real INSERT, not just per the parsed constraint text", () => {
    // Belt-and-suspenders: insert each name for real, so a future formatting change to the CHECK
    // clause that breaks the regex above can't mask a real mismatch.
    for (const agent of ASSIGNABLE_AGENT_NAMES) {
      const id = `T-${agent}`;
      expect(() =>
        db
          .prepare(
            `INSERT INTO tasks (id, title, status, priority, phase, agent, created, deliverable_type, attempts, body)
             VALUES (?, 'Task', 'backlog', 'P2', 0, ?, '2026-08-01', 'code', 0, '')`
          )
          .run(id, agent)
      ).not.toThrow();
    }
  });
});
