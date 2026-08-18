-- T-0117: petition_tier table — unique vocabulary tier tracking.
--
-- 02-notes-system.md §5: unique tier is a "deep unlock, few per player"
-- capability that gates access to broadcast petitions (§6).
--
-- Separate from the vocabulary table (per-word grants) because petition
-- capability is a holistic milestone — not tied to a specific word ID.
-- Populated by the progression subsystem (future task); seeded directly
-- in tests and via debug APIs.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS is a no-op on a second run.

CREATE TABLE IF NOT EXISTS petition_tier (
    token      TEXT        NOT NULL PRIMARY KEY REFERENCES identity(token),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
