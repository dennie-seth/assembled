-- T-0118: reverse of 015_unique_custody_log.sql
-- Idempotent: DROP IF EXISTS is a no-op when the table does not exist.

DROP INDEX IF EXISTS unique_custody_log_unique_id_at_idx;
DROP TABLE IF EXISTS unique_custody_log;
