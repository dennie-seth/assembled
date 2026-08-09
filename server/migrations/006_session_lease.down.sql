-- T-0093 down: drop session_lease table.
-- Idempotent: DROP TABLE IF EXISTS is a no-op when the table is absent.

DROP TABLE IF EXISTS session_lease;
