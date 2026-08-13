-- T-0095/T-0096: item economy tables — item_type, item_instance.
--
-- item_type     immutable catalogue of what kinds of items exist.
--               rarity: 0 common | 1 rare | 2 unique (07-items-economy.md §2)
--
-- item_instance every tracked item UUID with its custody chain.
--               holder     TEXT NULL REFERENCES identity  — who holds it in inventory
--               hosted_by  TEXT NULL REFERENCES identity  — whose universe anchors it
--               Exactly one of (holder, hosted_by) must be non-null (INV-1).
--               version    INT — optimistic-concurrency guard (INV-2), incremented
--                          on every custody change by the CAS UPDATE in ItemRepo.
--               custody_depth INT — strictly increases on transfer (INV-5).
--
-- INV-1 is made structural by the CHECK constraint; application-level bugs
-- cannot produce a "zero holder" or "two holder" row.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS is a no-op on a second run.

CREATE TABLE IF NOT EXISTS item_type (
    id     SMALLINT PRIMARY KEY,
    rarity SMALLINT NOT NULL
);

CREATE TABLE IF NOT EXISTS item_instance (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    type_id        SMALLINT    NOT NULL REFERENCES item_type,
    origin_palette SMALLINT    NOT NULL DEFAULT 0,
    shard_id       SMALLINT    NOT NULL DEFAULT 0,
    holder         TEXT        NULL REFERENCES identity(token),
    hosted_by      TEXT        NULL REFERENCES identity(token),
    anchor_arch    SMALLINT    NULL,
    anchor_tag     SMALLINT    NULL,
    custody_depth  INT         NOT NULL DEFAULT 0,
    version        INT         NOT NULL DEFAULT 0,
    bleed_at       TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '90 minutes',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- INV-1: exactly one of holder / hosted_by must be non-null.
    -- num_nonnulls counts non-NULL arguments; the result must equal 1.
    CONSTRAINT item_instance_single_custody
        CHECK (num_nonnulls(holder, hosted_by) = 1),

    -- Anchor coherence: an item in the world must name its universe (hosted_by)
    -- and its anchor location (anchor_arch, anchor_tag), or none of them.
    CONSTRAINT item_instance_anchor_coherence
        CHECK ((hosted_by IS NULL) = (anchor_arch IS NULL)),
    CONSTRAINT item_instance_anchor_pair
        CHECK ((anchor_arch IS NULL) = (anchor_tag IS NULL)),

    -- anchor_arch/anchor_tag must reference a declared anchor position.
    CONSTRAINT item_instance_anchor_fk
        FOREIGN KEY (anchor_arch, anchor_tag)
        REFERENCES anchor_tag(archetype_id, tag)
);
