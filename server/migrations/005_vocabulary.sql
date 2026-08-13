-- T-0045: vocabulary table.
--
-- Tracks which note_words each identity has unlocked.  The word_id FK
-- into note_words ensures only legitimate word IDs are stored — no free
-- text can be back-doored through this table.
--
-- The POST /v1/notes handler checks this table before accepting a compose
-- request; any slot word absent from the caller's vocabulary returns 403
-- VOCAB_TIER_LOCKED (error 4002).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS is a no-op on a second run.

CREATE TABLE IF NOT EXISTS vocabulary (
    token   TEXT     NOT NULL REFERENCES identity(token),
    word_id SMALLINT NOT NULL REFERENCES note_words(id),
    PRIMARY KEY (token, word_id)
);
