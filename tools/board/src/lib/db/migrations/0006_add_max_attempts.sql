-- T-0343: per-card override of the bounded auto-retry loop's attempt budget
-- (src/runner/runOrchestrator.js's MAX_AUTO_RETRY_ATTEMPTS). Nullable: NULL means "no
-- explicit override", so the orchestrator's own MAX_AUTO_RETRY_ATTEMPTS constant applies
-- exactly as it did before this column existed -- the compatibility guarantee this card's
-- acceptance criteria calls for. Range/type validation (integer 1-20) lives in
-- taskParser.js's validateTask, the same layer that already validates `attempts` -- matching
-- that field's own precedent of no DB-level CHECK constraint duplicating the business rule.
--
-- Plain ADD COLUMN, no default needed: SQLite gives every existing row NULL for a new
-- nullable column with no DEFAULT clause.

ALTER TABLE tasks ADD COLUMN max_attempts INTEGER;
