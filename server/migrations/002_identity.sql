-- T-0094: identity table.
--
-- Stores the *derived token* only. The seed phrase is generated server-side,
-- returned to the caller exactly once, and immediately discarded -- it never
-- touches this table (UGC invariant: no phrase TEXT column, see sql.md).
-- Token derivation is HMAC-SHA256(server_secret, phrase); the phrase cannot
-- be recovered from the token even with full database access.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS is a no-op on a second run.

CREATE TABLE IF NOT EXISTS identity (
    token       TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT  identity_pkey PRIMARY KEY (token)
);
