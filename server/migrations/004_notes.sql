-- T-0044: notes table — the core game artefact.
--
-- Every note is assembled from:
--   template_id  FK → note_templates(id)   — which template fills this note
--   slot_a       FK → note_words(id)        — first word slot (nullable)
--   slot_b       FK → note_words(id)        — second word slot (nullable)
--   item_ref     TEXT NULL                  — server-assigned item key;
--                                             not player free-text (no FK yet —
--                                             an items lookup table lands in a
--                                             future migration when the item
--                                             catalogue is finalised).
--
-- Arbitrary player text is UNREPRESENTABLE by schema design:
--   template_id/slot_a/slot_b all require rows from immutable lookup tables.
--
-- Lookup is equality on (archetype_id, anchor_tag) — discrete world (D-1).
-- No geometry column, no radius query, no PostGIS dependency.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS is a no-op on a second run.

CREATE TABLE IF NOT EXISTS notes (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    author_token TEXT        NOT NULL REFERENCES identity(token),
    archetype_id SMALLINT    NOT NULL,
    anchor_tag   SMALLINT    NOT NULL,
    template_id  SMALLINT    NOT NULL REFERENCES note_templates(id),
    slot_a       SMALLINT    REFERENCES note_words(id),
    slot_b       SMALLINT    REFERENCES note_words(id),
    item_ref     TEXT        NULL,
    rating       INT         NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT notes_anchor_fk
        FOREIGN KEY (archetype_id, anchor_tag)
        REFERENCES anchor_tag(archetype_id, tag)
);
