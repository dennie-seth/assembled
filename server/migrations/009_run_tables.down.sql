-- Revert T-0123 run tables.  Idempotent.
DROP TABLE IF EXISTS archetype_seen;
DROP TABLE IF EXISTS run_variant;
DROP TABLE IF EXISTS run;
ALTER TABLE variant DROP COLUMN IF EXISTS room_count;
