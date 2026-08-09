-- T-0093: session_lease table — INV-11 one live session per identity.
--
-- Keyed on token (FK -> identity).  PRIMARY KEY on token makes a second
-- concurrent session structurally unrepresentable, not merely rejected:
-- there is exactly one row per identity, so acquiring a new lease simply
-- overwrites the old one (the UPSERT in SessionLeaseRepo::acquire).
--
-- lease_id   the opaque handle the client holds; heartbeat fails if it
--            does not match, which is how the evicted client learns it
--            has been taken over.
-- expires_at wall-clock expiry; rows are only live while expires_at > now().
--
-- Idempotent: CREATE TABLE IF NOT EXISTS is a no-op on a second run.

CREATE TABLE IF NOT EXISTS session_lease (
    token      TEXT        NOT NULL,
    lease_id   TEXT        NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT session_lease_pkey PRIMARY KEY (token),
    CONSTRAINT session_lease_identity_fk
        FOREIGN KEY (token) REFERENCES identity(token)
);
