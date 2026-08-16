-- Widens tasks.agent's CHECK constraint to accept 'generic' (docs/design/cards-to-database.md's
-- 0001 schema predates the generic default-agent work -- see taskParser.js's
-- ASSIGNABLE_AGENT_NAMES, which already includes it). SQLite has no ALTER TABLE for CHECK
-- constraints, so this rebuilds the table per the standard 12-step recipe
-- (https://www.sqlite.org/lang_altertable.html#otheralter). migrate.js's runMigrations()
-- toggles `PRAGMA foreign_keys` OFF around this whole migration (outside this transaction --
-- that pragma is a no-op mid-transaction) specifically so this DROP doesn't perform an
-- implicit cascading DELETE against task_dependencies/comments/attachments before the rename
-- restores the `tasks` name -- confirmed live: with foreign_keys left on, every child row
-- referencing an existing task was wiped by the DROP. `agent IS NULL` stays legal -- existing
-- null-agent cards are reported to the user for a separate, deliberate backfill, not silently
-- rewritten by a migration.

CREATE TABLE tasks_new (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN
                     ('backlog','ready','in-progress','validation','review','done','blocked','retired')),
  priority         TEXT NOT NULL CHECK (priority IN ('P0','P1','P2','P3')),
  phase            INTEGER NOT NULL,
  agent            TEXT CHECK (agent IN ('infra','server','client','assets','audio','planner','generic') OR agent IS NULL),
  created          TEXT NOT NULL,
  branch           TEXT,
  commit_sha       TEXT,
  pr               TEXT,
  deliverable_type TEXT NOT NULL DEFAULT 'code' CHECK (deliverable_type IN ('code','artifact')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  body             TEXT NOT NULL DEFAULT ''
);

INSERT INTO tasks_new SELECT * FROM tasks;

DROP TABLE tasks;

ALTER TABLE tasks_new RENAME TO tasks;
