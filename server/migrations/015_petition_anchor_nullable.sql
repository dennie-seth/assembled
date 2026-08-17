-- T-0117: allow NULL anchor columns in notes for is_broadcast = true petitions.
--
-- Broadcast petition notes (02-notes-system.md §6) have no anchor — they surface
-- across the network rather than binding to a specific (archetype, tag) position.
-- The existing NOT NULL constraints on archetype_id and anchor_tag prevent NULL
-- inserts, so they must be relaxed.
--
-- PostgreSQL FK behaviour: a composite FK is only enforced when ALL FK columns are
-- non-null. Rows with both columns NULL (broadcast notes) pass the existing
-- notes_anchor_fk constraint without requiring its removal or modification.
--
-- A coherence CHECK prevents the "one null, one non-null" half-state that would
-- silently bypass the FK without being broadcast.
--
-- Idempotent: ALTER COLUMN ... DROP NOT NULL is a no-op when already nullable.
-- ADD CONSTRAINT IF NOT EXISTS is a no-op when the constraint already exists (Postgres 9.6+).

ALTER TABLE notes
    ALTER COLUMN archetype_id DROP NOT NULL,
    ALTER COLUMN anchor_tag   DROP NOT NULL;

ALTER TABLE notes
    ADD CONSTRAINT IF NOT EXISTS notes_anchor_coherence
    CHECK ((archetype_id IS NULL) = (anchor_tag IS NULL));
