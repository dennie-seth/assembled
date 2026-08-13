-- T-0125: revert 012_sweep_tables.sql.
--
-- Removes sweep-worker tables, index, and identity columns.
-- Idempotent: each DROP uses IF EXISTS.

DROP INDEX IF EXISTS transfer_receipt_created_at_idx;
DROP INDEX IF EXISTS identity_collapse_expires_at_idx;
DROP INDEX IF EXISTS item_instance_type_id_idx;
DROP INDEX IF EXISTS item_instance_bleed_at_idx;

DROP TABLE IF EXISTS economy_ledger;
DROP TABLE IF EXISTS type_census;
DROP TABLE IF EXISTS transfer_receipt;

ALTER TABLE identity
    DROP COLUMN IF EXISTS first_universe,
    DROP COLUMN IF EXISTS collapse_expires_at;
