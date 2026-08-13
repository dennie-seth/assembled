-- Reverts T-0047: drop note_votes.
-- notes.rating loses its backing data; reset to 0 so the column is not stale.
-- Idempotent: DROP TABLE IF EXISTS / UPDATE are both safe on a clean schema.

DROP TABLE IF EXISTS note_votes;
UPDATE notes SET rating = 0;
