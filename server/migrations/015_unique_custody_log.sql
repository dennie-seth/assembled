-- T-0118: unique_custody_log — append-only custody history for unique items.
--
-- Every custody change on a unique instance appends a new row rather than
-- mutating the existing one.  Current custody is derived as the row with the
-- highest seq for a given unique_id; there is no separately maintained state
-- column.  (15-server-ops.md §9.2)
--
-- event codes (SMALLINT, stored as integers matching CustodyEvent in C++):
--   0 seed      — unique seeded into the world for the first time
--   1 lease     — lease granted to a shard by UniqueAuthority (§4)
--   2 take      — identity picks the unique up from a world anchor
--   3 use       — identity uses the unique in place (held -> anchored)
--   4 bleed     — sweep worker moves it to a new anchor (bleed cycle)
--   5 release   — lease/escrow release returns it to the authority
--   6 complete  — exit-condition completion (win state)
--
-- holder / hosted_by are TEXT matching identity.token (TEXT PRIMARY KEY).
-- They are NOT foreign-keyed to identity so that the audit log survives
-- identity collapse events while retaining the full historical record.
--
-- seq is monotonic per unique_id, assigned as MAX(seq)+1 in a single INSERT
-- statement (atomic within one statement; UniqueAuthority is a global singleton
-- so concurrent writers for the same unique_id do not occur in practice).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS is a no-op on a second run.

CREATE TABLE IF NOT EXISTS unique_custody_log (
    unique_id     UUID        NOT NULL,
    seq           BIGINT      NOT NULL,
    holder        TEXT        NULL,
    hosted_by     TEXT        NULL,
    shard_id      SMALLINT    NULL,
    lease_expires TIMESTAMPTZ NULL,
    event         SMALLINT    NOT NULL
        CHECK (event BETWEEN 0 AND 6),
    at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (unique_id, seq)
);

-- Index to accelerate currentCustody (ORDER BY seq DESC LIMIT 1) and
-- custodyAt (WHERE unique_id = $1 AND at <= $2 ORDER BY seq DESC LIMIT 1).
CREATE INDEX IF NOT EXISTS unique_custody_log_unique_id_at_idx
    ON unique_custody_log (unique_id, at DESC);
