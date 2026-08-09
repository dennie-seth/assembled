-- T-0095: variant and unlock tables for progression tracking.
--
-- variant   — catalogue of archetype variants; referenced by unlock rows.
--             Populated by level-design / seed migrations; immutable once seeded.
--
-- unlock    — per-identity unlock records with wall-clock expiry.
--             Written transactionally alongside an ItemRepo::use() transfer —
--             the same CAS that moves the item atomically writes this row.
--             (10-time-and-progression.md §3, INV-2)
--
-- No free-text player columns; all identifiers are FK references or server-
-- minted tokens, so no player-controlled text is representable.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS is a no-op on a second run.

CREATE TABLE IF NOT EXISTS variant (
    id                SMALLINT PRIMARY KEY,
    archetype_id      SMALLINT NOT NULL REFERENCES archetype,
    unlock_population INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS unlock (
    token      TEXT        NOT NULL REFERENCES identity(token),
    variant_id SMALLINT    NOT NULL REFERENCES variant,
    tag        SMALLINT    NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (token, variant_id, tag)
);
