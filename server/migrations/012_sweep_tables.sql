-- T-0125: sweep worker support tables.
--
-- Adds the columns and tables the sweep worker reads and writes:
--
--   identity.collapse_expires_at  — wall-clock deadline for the identity's
--                                   universe (10-time-and-progression.md §5).
--                                   Defaulted to 21 days from migration time
--                                   for existing rows.
--   identity.first_universe       — grace-period flag (10-time-and-progression.md
--                                   §5).  True until the first collapse.
--
--   type_census                   — live item count per type_id; refreshed by
--                                   the census phase every sweep cycle for
--                                   INV-6 / INV-7 monitoring.
--
--   economy_ledger                — per-sweep audit trail for INV-3.
--                                   Conservation: Δ total = spawns − unlanded.
--
--   Indexes from 04-data-model.md §8 needed by the sweep worker.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CREATE
-- INDEX IF NOT EXISTS are no-ops on a second run.

-- ─── identity additions ───────────────────────────────────────────────────────

ALTER TABLE identity
    ADD COLUMN IF NOT EXISTS collapse_expires_at TIMESTAMPTZ
        NOT NULL DEFAULT now() + INTERVAL '21 days',
    ADD COLUMN IF NOT EXISTS first_universe BOOLEAN
        NOT NULL DEFAULT true;

-- ─── transfer_receipt ─────────────────────────────────────────────────────────
--
-- transfer_receipt is defined and owned by migration 013_transfer_receipts.sql
-- (T-0126).  This migration (012) does not create it; only the sweep worker's
-- runRetention() reads and deletes from it after 013 has run.
--
-- ─── type_census ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS type_census (
    type_id    SMALLINT    PRIMARY KEY REFERENCES item_type,
    live_count INT         NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── economy_ledger ───────────────────────────────────────────────────────────
--
-- Append-only audit trail written by the sweep worker's bleed phase.
-- Conservation invariant: Δ total = spawned − unlanded − transmute_sink.

CREATE TABLE IF NOT EXISTS economy_ledger (
    at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    spawned        INT         NOT NULL DEFAULT 0,
    unlanded       INT         NOT NULL DEFAULT 0,
    transmute_sink INT         NOT NULL DEFAULT 0
);

-- ─── Indexes (04-data-model.md §8) ───────────────────────────────────────────

CREATE INDEX IF NOT EXISTS item_instance_bleed_at_idx
    ON item_instance (bleed_at);

CREATE INDEX IF NOT EXISTS item_instance_type_id_idx
    ON item_instance (type_id);

CREATE INDEX IF NOT EXISTS identity_collapse_expires_at_idx
    ON identity (collapse_expires_at);

-- transfer_receipt_created_at_idx is defined in 013_transfer_receipts.sql (T-0126).
