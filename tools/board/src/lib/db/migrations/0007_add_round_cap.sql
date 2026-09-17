-- T-0344: the experiment-round cap (src/lib/roundCap.js). `round` counts how many rounds this
-- card has settled without a promoted deliverable since it was last reset (by a PASS or a human
-- re-scope acknowledgment); `rescoped_by`/`rescoped_at` record that acknowledgment. Same
-- precedent as 0006_add_max_attempts.sql: plain ADD COLUMN, range/type validation lives in
-- taskParser.js's validateTask, not a DB-level CHECK constraint.
--
-- `round` defaults to 0 so every existing row (and every card created before this migration)
-- reads as "never capped" -- the cap is never applied retroactively.

ALTER TABLE tasks ADD COLUMN round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN rescoped_by TEXT;
ALTER TABLE tasks ADD COLUMN rescoped_at TEXT;
