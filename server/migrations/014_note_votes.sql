-- T-0047: note_votes — one vote per (note_id, voter).
--
-- val is +1 or -1, enforced by CHECK.  The PRIMARY KEY (note_id, voter)
-- guarantees at most one row per voter per note; an UPSERT over this key
-- is a no-op when val is unchanged and overwrites cleanly when it changes.
--
-- notes.rating is kept as a denormalized SUM(val) over note_votes and is
-- updated atomically alongside the upsert in PgNoteRepo::rate.
--
-- ON DELETE CASCADE ensures that dropping a note also drops its votes.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS is a no-op on a second run.

CREATE TABLE IF NOT EXISTS note_votes (
    note_id  UUID     NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    voter    TEXT     NOT NULL REFERENCES identity(token),
    val      SMALLINT NOT NULL CHECK (val IN (1, -1)),
    PRIMARY KEY (note_id, voter)
);
