-- T-0045: revert 005_vocabulary.sql
-- Idempotent: DROP TABLE IF EXISTS is a no-op when the table is absent.

DROP TABLE IF EXISTS vocabulary;
