-- Revert 015_petition_anchor_nullable: restore NOT NULL on anchor columns.
--
-- Will fail if any is_broadcast=true (NULL-anchor) rows exist; purge those first.
-- Idempotent: DROP CONSTRAINT IF EXISTS and SET NOT NULL are safe to re-run.

ALTER TABLE notes
    DROP CONSTRAINT IF EXISTS notes_anchor_coherence;

ALTER TABLE notes
    ALTER COLUMN archetype_id SET NOT NULL,
    ALTER COLUMN anchor_tag   SET NOT NULL;
