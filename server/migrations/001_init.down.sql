-- Reverts 001_init.sql. Idempotent: DROP EXTENSION IF EXISTS is a no-op if
-- already reverted.
DROP EXTENSION IF EXISTS pgcrypto;
