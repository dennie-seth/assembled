---
paths: ["server/**/migrations/**"]
---

# SQL / migrations

- Plain SQL, no ORM. Migrations are `.sql` files tracked against a version
  table (e.g. `schema_migrations(version INT PRIMARY KEY, applied_at
  TIMESTAMPTZ)`) — not a framework-managed migration history.
- Every migration ships both directions: `up` applies the change, `down`
  reverts it. Both must be idempotent — running `up` twice, or `down` on an
  already-reverted schema, is a no-op, not an error.
- FK constraints are the UGC guarantee, not an afterthought. `template_id`,
  `slot_a`, `slot_b` on `notes` reference immutable lookup tables
  (`note_templates`, `note_words`); this is what makes arbitrary free-text
  content unrepresentable at the schema level. Any new player-facing column
  needs the same treatment — a lookup table + FK, never a free `TEXT`
  column a player controls.
- Seed data for immutable template tables comes from `shared/` headers (see
  `docs/PLAN.md` T-0043) — the SQL seed and the C++ header must stay in
  parity; a migration that adds a template ID without updating `shared/`
  (or vice versa) is incomplete.
- Use the `new-migration` skill to scaffold a new migration file rather than
  hand-rolling the version bump.
