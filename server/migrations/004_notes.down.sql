-- T-0044 down: drop the notes table.
-- Must run before 003 down (which drops note_templates / note_words / anchor_tag)
-- because notes holds FK references to those tables.
-- Idempotent: DROP TABLE IF EXISTS is a no-op when the table is absent.

DROP TABLE IF EXISTS notes;
