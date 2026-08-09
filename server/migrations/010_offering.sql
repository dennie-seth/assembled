-- T-0124: offering (escrow) table.
--
-- An offering puts an item_instance into escrow so any player can claim it
-- in exchange for an item of a specific type (03-net-protocol.md §5, Escrow).
-- The UNIQUE constraint on item_instance prevents one item from backing two
-- offerings simultaneously.
--
-- anchor_arch / anchor_tag must reference a declared anchor position via FK
-- so offerings can only exist at valid world locations.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS is a no-op on a second run.

CREATE TABLE IF NOT EXISTS offering (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    item_instance UUID        NOT NULL UNIQUE REFERENCES item_instance,
    wants_type    SMALLINT    NOT NULL REFERENCES item_type,
    anchor_arch   SMALLINT    NOT NULL,
    anchor_tag    SMALLINT    NOT NULL,
    author        TEXT        NOT NULL REFERENCES identity(token),
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT offering_anchor_fk
        FOREIGN KEY (anchor_arch, anchor_tag)
        REFERENCES anchor_tag(archetype_id, tag)
);

-- Index supporting the anchor-snapshot query (03-net-protocol.md §5).
CREATE INDEX IF NOT EXISTS offering_anchor_idx ON offering (anchor_arch, anchor_tag);
