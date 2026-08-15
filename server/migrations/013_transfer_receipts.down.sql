-- Revert 013_transfer_receipts.sql: drop the receipt table and its index.
-- Idempotent: DROP … IF EXISTS is a no-op when the object is already absent.

DROP INDEX IF EXISTS transfer_receipt_created_at_idx;
DROP TABLE IF EXISTS transfer_receipt;
