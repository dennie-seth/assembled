-- Revert 013_transfer_receipts.sql: drop the transfer_receipt table.
-- Idempotent: DROP TABLE IF EXISTS is a no-op when the table is already absent.

DROP TABLE IF EXISTS transfer_receipt;
