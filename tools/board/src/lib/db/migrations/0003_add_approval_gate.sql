-- Human direction-approval gate (src/lib/approvalGate.js, docs/board-invariants.md §9).
--
-- Adds the three columns the gate needs: the explicit `requires_approval` flag an author sets
-- on a card whose deliverable is a *direction* a human must sign off on, and the pair recording
-- who signed off and when. Every existing card defaults to "not gated, not approved", which is
-- exactly the pre-gate behaviour -- this migration changes no card's meaning.
--
-- Plain ADD COLUMNs, deliberately: unlike 0002 there is no CHECK constraint to widen, so this
-- needs none of that migration's CREATE/copy/DROP/RENAME table-rebuild recipe -- and therefore
-- none of its FK-cascade-on-DROP hazard either. SQLite's ADD COLUMN requires a non-volatile
-- default, which constant literals are.
--
-- `requires_approval` is INTEGER (SQLite has no boolean type); dbTaskStore coerces it to a real
-- JS boolean on read so the API shape matches taskParser's.

ALTER TABLE tasks ADD COLUMN requires_approval INTEGER NOT NULL DEFAULT 0
  CHECK (requires_approval IN (0, 1));

ALTER TABLE tasks ADD COLUMN approved_by TEXT;

ALTER TABLE tasks ADD COLUMN approved_at TEXT;
