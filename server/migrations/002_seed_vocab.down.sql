-- Reverts 002_seed_vocab.sql.
-- Drop order respects FK dependencies: anchor_tag before archetype,
-- all four tables before any table that references them (none yet, but
-- ordered defensively for future migrations).
-- Idempotent: DROP TABLE IF EXISTS is a no-op if already reverted.
DROP TABLE IF EXISTS anchor_tag;
DROP TABLE IF EXISTS archetype;
DROP TABLE IF EXISTS note_words;
DROP TABLE IF EXISTS note_templates;
