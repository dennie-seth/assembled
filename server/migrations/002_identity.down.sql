-- T-0094 down: drop identity table.
-- Idempotent: DROP TABLE IF EXISTS is a no-op when the table is absent.

DROP TABLE IF EXISTS identity;
