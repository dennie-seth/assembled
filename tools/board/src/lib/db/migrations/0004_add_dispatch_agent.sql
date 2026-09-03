-- Widens tasks.agent's CHECK constraint to accept 'dispatch', and reconciles the whole list
-- with taskParser.js's ASSIGNABLE_AGENT_NAMES so the two cannot drift again silently
-- (agentNamesLockstep.test.js now pins them together).
--
-- WHY: 'dispatch' is the escalation flow's non-executable sentinel. When a card's auto-retry
-- cap exhausts on a genuine blocker, RunOrchestrator drafts a remediation card with
-- `agent: "dispatch"` (escalationRemediation.js:70) so it surfaces for a human and the runner's
-- pick-up loop refuses to auto-run it. taskParser.js has listed 'dispatch' in
-- ASSIGNABLE_AGENT_NAMES all along, but 0001/0002's CHECK constraint never did -- so from the
-- db cutover onward EVERY escalation INSERT failed with
--   "CHECK constraint failed: agent IN ('infra',...,'generic') OR agent IS NULL"
-- the remediation card was never created, and the card was simply left blocked with no
-- follow-up. Observed 11x in a single day, end-to-end on T-0290. Escalation has been dead in
-- db mode for the entire life of the database.
--
-- SQLite has no ALTER TABLE for CHECK constraints, so this rebuilds the table per the standard
-- 12-step recipe (https://www.sqlite.org/lang_altertable.html#otheralter), exactly as 0002 did.
--
-- FK-CASCADE HAZARD (the PR #182 gotcha): task_dependencies, comments and attachments all
-- REFERENCE tasks(id) ON DELETE CASCADE, so with `PRAGMA foreign_keys` left ON the DROP below
-- performs an implicit cascading DELETE and wipes every child row before the RENAME restores
-- the `tasks` name -- confirmed live during 0002. migrate.js's runMigrations() toggles that
-- pragma OFF around each migration's transaction (never inside one -- SQLite treats it as a
-- no-op mid-transaction) precisely so this is safe. dbMigrate0004.test.js asserts the child
-- rows actually survive rather than trusting that.
--
-- Column list is spelled out explicitly on both sides of the copy rather than `SELECT *`:
-- 0003 appended requires_approval/approved_by/approved_at via ADD COLUMN, so the table's
-- column order is 0002's 13 followed by those 3, and naming them makes this migration
-- independent of that ordering.
--
-- `agent IS NULL` stays legal, as in 0002 -- null-agent cards are a deliberate, separately
-- tracked backfill, never something a migration rewrites.

CREATE TABLE tasks_new (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                      ('backlog','ready','in-progress','validation','review','done','blocked','retired')),
  priority          TEXT NOT NULL CHECK (priority IN ('P0','P1','P2','P3')),
  phase             INTEGER NOT NULL,
  agent             TEXT CHECK (agent IN
                      ('infra','server','client','assets','audio','generic','planner','dispatch')
                      OR agent IS NULL),
  created           TEXT NOT NULL,
  branch            TEXT,
  commit_sha        TEXT,
  pr                TEXT,
  deliverable_type  TEXT NOT NULL DEFAULT 'code' CHECK (deliverable_type IN ('code','artifact')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  body              TEXT NOT NULL DEFAULT '',
  requires_approval INTEGER NOT NULL DEFAULT 0 CHECK (requires_approval IN (0, 1)),
  approved_by       TEXT,
  approved_at       TEXT
);

INSERT INTO tasks_new (
  id, title, status, priority, phase, agent, created, branch, commit_sha, pr,
  deliverable_type, attempts, body, requires_approval, approved_by, approved_at
)
SELECT
  id, title, status, priority, phase, agent, created, branch, commit_sha, pr,
  deliverable_type, attempts, body, requires_approval, approved_by, approved_at
FROM tasks;

DROP TABLE tasks;

ALTER TABLE tasks_new RENAME TO tasks;
