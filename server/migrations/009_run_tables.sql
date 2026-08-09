-- T-0123: run, run_variant, and archetype_seen tables for the run assembler.
-- Also adds room_count to variant — needed for size-aware selection against
-- the 18-room cap (01-vision.md §7, 16-level-design.md §2).
--
-- run          — one waking per identity (01-vision.md §6).
-- run_variant  — per-run record of selected variants; analytics/debug path
--                (04-data-model.md §6 — "not on the hot path").
-- archetype_seen — set-based proof-of-play record, upserted on every
--                  assembly; a single PK lookup on the rating hot path
--                  (04-data-model.md §6 — replaces the old run_archetypes join).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.

-- room_count: how many rooms this variant contributes to a run.
-- Authored in the 5-8 band (01-vision.md §7); DEFAULT 5 guards against
-- un-authored variants that slip through before the band is populated.
ALTER TABLE variant ADD COLUMN IF NOT EXISTS room_count SMALLINT NOT NULL DEFAULT 5;

-- run: one record per assembled run.
-- end_reason: 0 = death | 1 = quit | 2 = lease_expiry (01-vision.md §6).
CREATE TABLE IF NOT EXISTS run (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    token      TEXT        NOT NULL REFERENCES identity(token),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at   TIMESTAMPTZ NULL,
    end_reason SMALLINT    NULL
);

-- run_variant: the 3 variants that were assembled for this run.
-- One row per (run, variant); 3 rows total per run.
CREATE TABLE IF NOT EXISTS run_variant (
    run_id     UUID     NOT NULL REFERENCES run,
    variant_id SMALLINT NOT NULL REFERENCES variant,
    PRIMARY KEY (run_id, variant_id)
);

-- archetype_seen: upserted on assembly — one row per (identity, archetype) ever seen.
-- The proof-of-play check (02-notes-system.md §7, D-12) queries this table;
-- last_seen_at tracks recency for future analytics.
CREATE TABLE IF NOT EXISTS archetype_seen (
    token        TEXT        NOT NULL REFERENCES identity(token),
    archetype_id SMALLINT    NOT NULL REFERENCES archetype,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (token, archetype_id)
);
