-- Initial schema for the cards-to-database refactor (docs/design/cards-to-database.md).
-- Table shapes follow the design doc's "Schema" section. Two additions beyond the doc's
-- literal DDL, both called out in the Phase 1 report: card_events gets `action` and `actor`
-- columns (the doc's block only has task_id/changed/created_at), and the three child tables
-- (task_dependencies, comments, attachments) get an explicit ON DELETE CASCADE so that
-- DbTaskStore.remove() can delete a task's row without a foreign-key violation, matching
-- FsTaskStore.remove()'s behavior of deleting a card and everything embedded in it.

CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,             -- "T-0148" -- string form kept: worktree/branch
                                                   -- names, .runs/<id> paths, and prompts all key off it
  title            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN
                     ('backlog','ready','in-progress','validation','review','done','blocked','retired')),
  priority         TEXT NOT NULL CHECK (priority IN ('P0','P1','P2','P3')),
  phase            INTEGER NOT NULL,
  agent            TEXT CHECK (agent IN ('infra','server','client','assets','audio','planner') OR agent IS NULL),
  created          TEXT NOT NULL,                 -- "YYYY-MM-DD"
  branch           TEXT,
  commit_sha       TEXT,                          -- "commit" is a SQL-adjacent word; avoid the collision
  pr               TEXT,
  deliverable_type TEXT NOT NULL DEFAULT 'code' CHECK (deliverable_type IN ('code','artifact')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  body             TEXT NOT NULL DEFAULT ''
);

CREATE TABLE task_dependencies (                  -- replaces the depends_on JSON array
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL,                     -- not FK-enforced: a dangling ref is a *validation*
                                                    -- error (backlogValidator's job), not a DB-integrity one
  PRIMARY KEY (task_id, depends_on_id)
);
CREATE INDEX idx_task_dependencies_task_id ON task_dependencies(task_id);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL                         -- ISO-8601, matches today's comment.timestamp
);
CREATE INDEX idx_comments_task_id ON comments(task_id);

CREATE TABLE attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mimetype    TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  UNIQUE (task_id, filename)                       -- makes "exactly one entry per stored filename"
);                                                  -- (httpApi.js:406-410) a DB constraint, not app logic
CREATE INDEX idx_attachments_task_id ON attachments(task_id);

CREATE TABLE card_events (                          -- audit trail -- replaces git history
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL,                         -- deliberately not FK'd: an event must survive
                                                      -- its task being removed, so history of a
                                                      -- deleted card is still queryable
  action     TEXT NOT NULL CHECK (action IN ('create','update','move','remove')),
  changed    TEXT NOT NULL,                         -- JSON list of changed field names
  actor      TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_card_events_task_id ON card_events(task_id);

CREATE TABLE id_allocator (next_seq INTEGER NOT NULL);  -- single row; see idAllocatorDb.js
INSERT INTO id_allocator (next_seq) VALUES (0);
