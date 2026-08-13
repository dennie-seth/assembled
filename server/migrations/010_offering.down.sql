-- Revert 010_offering.sql: drop offering table and its index.
-- Idempotent: DROP IF EXISTS is a no-op when already absent.

DROP INDEX IF EXISTS offering_anchor_idx;
DROP TABLE IF EXISTS offering;
