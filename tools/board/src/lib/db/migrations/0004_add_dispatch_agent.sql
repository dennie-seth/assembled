-- Widens tasks.agent's CHECK constraint to accept 'dispatch' (T-0301). taskParser.js's
-- ASSIGNABLE_AGENT_NAMES already carries 'dispatch' -- the non-executable escalation sentinel
-- RunOrchestrator.runCard refuses to auto-run (see taskParser.js's ASSIGNABLE_AGENT_NAMES
-- docstring and runOrchestrator.js's `task.agent === "dispatch"` guard) -- but 0002's rebuilt
-- CHECK constraint never picked it up. Since the db-store cutover this has silently killed every
-- db-mode escalation: RunOrchestrator._escalateIfGenuineBlocker's remediation-card INSERT throws
-- "CHECK constraint failed", is caught, and is only ever logged -- never surfaced -- leaving a
-- card that exhausted its retries simply stuck `blocked` with no human handoff.
--
-- Diff of ASSIGNABLE_AGENT_NAMES vs the 0002-era constraint: 'dispatch' is the only value the
-- constraint was missing -- 'infra','server','client','assets','audio','planner','generic' were
-- already present on both sides.
--
-- Same rebuild recipe as 0002 (SQLite has no ALTER TABLE for CHECK constraints) and the same
-- FK-cascade-on-DROP hazard from PR #182's generic-default-agent work: migrate.js's
-- runMigrations() toggles `PRAGMA foreign_keys` OFF around this migration's transaction so the
-- DROP TABLE below doesn't cascade-delete task_dependencies/comments/attachments before the
-- rename restores the `tasks` name. tasks_new's column list/order below matches the table's
-- actual current shape -- 0002's rebuilt columns plus the three approval-gate columns 0003 added
-- via ALTER TABLE ADD COLUMN (requires_approval, approved_by, approved_at), since `INSERT INTO
-- tasks_new SELECT * FROM tasks` is positional.

CREATE TABLE tasks_new (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                      ('backlog','ready','in-progress','validation','review','done','blocked','retired')),
  priority          TEXT NOT NULL CHECK (priority IN ('P0','P1','P2','P3')),
  phase             INTEGER NOT NULL,
  agent             TEXT CHECK (agent IN ('infra','server','client','assets','audio','planner','generic','dispatch') OR agent IS NULL),
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

INSERT INTO tasks_new SELECT * FROM tasks;

DROP TABLE tasks;

ALTER TABLE tasks_new RENAME TO tasks;
