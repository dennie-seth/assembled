-- T-0126: transfer_receipt table for idempotent custody-change requests.
--
-- Every leave/use/take/transmute request carries a client-minted transfer_id
-- UUID. The server persists the outcome of each transfer keyed on that UUID
-- (03-net-protocol.md §4). A repeated request with the same transfer_id
-- returns the stored receipt without re-running the compare-and-swap.
--
-- outcome: 'pending' while the CAS is in flight; 'won' or 'lost' once settled.
--
-- bleed_at: 72 h from creation, matching the world/escrow bleed window (T-0125).
--   After expiry, tryClaimSlot() removes the stale row and treats the transfer
--   as fresh — consistent with T-0125's sweep worker deleting the row at the
--   same horizon.
--
-- new_version, new_custody_depth: populated on a Won transfer (leave/use/take).
-- new_item_id: populated only on a Won transmute (the newly minted item).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS is a no-op on a second run.

CREATE TABLE IF NOT EXISTS transfer_receipt (
    transfer_id       UUID         PRIMARY KEY,
    kind              TEXT         NOT NULL
        CHECK (kind IN ('leave', 'use', 'take', 'transmute')),
    item_id           UUID         NOT NULL,
    outcome           TEXT         NOT NULL DEFAULT 'pending'
        CHECK (outcome IN ('pending', 'won', 'lost')),
    new_version       INT          NULL,
    new_custody_depth INT          NULL,
    new_item_id       UUID         NULL,
    bleed_at          TIMESTAMPTZ  NOT NULL DEFAULT now() + INTERVAL '72 hours',
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transfer_receipt_created_at_idx
    ON transfer_receipt (created_at);
