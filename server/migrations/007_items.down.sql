-- T-0095/T-0096 rollback: drop item economy tables.
-- Must run before 003 down (anchor_tag) and 002 down (identity).
-- Idempotent: DROP TABLE IF EXISTS is a no-op when the table is absent.

DROP TABLE IF EXISTS item_instance;
DROP TABLE IF EXISTS item_type;
