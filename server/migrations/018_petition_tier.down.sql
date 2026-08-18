-- Revert 018_petition_tier: drop the unique-vocab-tier tracking table.
-- Idempotent: DROP TABLE IF EXISTS is a no-op when already absent.

DROP TABLE IF EXISTS petition_tier;
