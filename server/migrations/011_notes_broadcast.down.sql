-- Revert 011_notes_broadcast.sql: drop is_broadcast from notes.
-- Idempotent: DROP COLUMN IF EXISTS is a no-op when already absent.

ALTER TABLE notes
    DROP COLUMN IF EXISTS is_broadcast;
