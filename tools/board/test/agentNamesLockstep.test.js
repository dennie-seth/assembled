import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { runMigrations } from "../src/lib/db/migrate.js";
import { ASSIGNABLE_AGENT_NAMES } from "../src/lib/taskParser.js";

// T-0301: escalation was DEAD in db mode from the cutover until this test existed.
//
// taskParser's ASSIGNABLE_AGENT_NAMES included "dispatch" -- the non-executable sentinel the
// escalation flow assigns a remediation card so a retry-exhausted card surfaces for a human
// (escalationRemediation.js:70) -- but the tasks.agent CHECK constraint did not. Every
// escalation therefore failed its INSERT with
//   "CHECK constraint failed: agent IN ('infra',...,'generic') OR agent IS NULL"
// and no remediation card was ever created. Observed 11x in one day, end-to-end on T-0290.
//
// The two lists are a single conceptual thing kept in two places, so this pins them in
// lockstep: it fails if either side gains an agent the other does not have.

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/lib/db/migrations"
);

let tmpDir;
let db;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-agent-lockstep-"));
  db = new Database(path.join(tmpDir, "test.db"));
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Pulls the agent CHECK constraint's allowed values straight out of the live schema. */
function agentsAllowedByCheckConstraint(database) {
  const { sql } = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
    .get();
  const match = /agent\s+TEXT\s+CHECK\s*\(\s*agent\s+IN\s*\(([^)]*)\)/i.exec(sql);
  if (!match) throw new Error(`could not find the agent CHECK constraint in:\n${sql}`);
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/^'/, "").replace(/'$/, ""))
    .filter(Boolean);
}

describe("tasks.agent CHECK constraint vs ASSIGNABLE_AGENT_NAMES (T-0301)", () => {
  it("allows exactly the agents taskParser considers assignable -- no drift in either direction", () => {
    runMigrations(db, MIGRATIONS_DIR);

    const allowed = agentsAllowedByCheckConstraint(db);

    expect([...allowed].sort()).toEqual([...ASSIGNABLE_AGENT_NAMES].sort());
  });

  it("accepts an INSERT for every assignable agent, so no agent is writable in theory only", () => {
    runMigrations(db, MIGRATIONS_DIR);

    const insert = db.prepare(
      "INSERT INTO tasks (id, title, status, priority, phase, agent, created) " +
        "VALUES (?, ?, 'backlog', 'P2', 1, ?, '2026-09-03')"
    );

    for (const [i, agent] of ASSIGNABLE_AGENT_NAMES.entries()) {
      const id = `T-9${String(i).padStart(3, "0")}`;
      expect(() => insert.run(id, `card for ${agent}`, agent)).not.toThrow();
    }

    // ...and NULL stays legal (0002 deliberately preserved null-agent cards).
    expect(() => insert.run("T-9900", "no agent", null)).not.toThrow();
  });

  it("specifically accepts 'dispatch', the escalation sentinel that was rejected before T-0301", () => {
    runMigrations(db, MIGRATIONS_DIR);

    expect(ASSIGNABLE_AGENT_NAMES).toContain("dispatch");
    expect(agentsAllowedByCheckConstraint(db)).toContain("dispatch");
  });

  it("still rejects an agent that is on neither list", () => {
    runMigrations(db, MIGRATIONS_DIR);

    expect(() =>
      db
        .prepare(
          "INSERT INTO tasks (id, title, status, priority, phase, agent, created) " +
            "VALUES ('T-9999', 'bogus', 'backlog', 'P2', 1, 'not-a-real-agent', '2026-09-03')"
        )
        .run()
    ).toThrow(/CHECK constraint failed/);
  });
});
