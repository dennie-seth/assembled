-- T-0124: add is_broadcast column to notes.
--
-- is_broadcast = true marks petition/broadcast notes that have no anchor
-- (04-data-model.md §5). The anchor-snapshot query (T-0124) filters these out;
-- they surface via a separate path (T-0117).
--
-- Existing rows are non-broadcast by definition, so DEFAULT false is correct
-- for the backfill.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op on a second run.

ALTER TABLE notes
    ADD COLUMN IF NOT EXISTS is_broadcast BOOLEAN NOT NULL DEFAULT false;
