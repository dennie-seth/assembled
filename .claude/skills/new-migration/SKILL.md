---
name: new-migration
description: Scaffolds a plain-SQL migration for server/** with an up/down pair and a version-table bump. No ORM. Use before hand-writing a schema change.
---

# new-migration

Used by the `server` agent to start a schema change. See
`.claude/rules/sql.md` for the conventions this scaffold follows.

## Steps

1. Determine the next version number from the existing `schema_migrations`
   entries (or `001` if this is the first migration).
2. Create the migration file(s) following the project's existing migration
   directory naming (check `server/**/migrations/` for the established
   pattern — a numbered prefix plus a short slug, e.g. `003_add_ratings.sql`
   with a paired `003_add_ratings.down.sql`, or an `-- up` / `-- down`
   section split, whichever the directory already uses).
3. Write the `up` section: the schema change itself, plus any FK
   constraints needed to keep new player-facing columns
   non-free-text (see `.claude/rules/conduct.md`).
4. Write the `down` section: the exact inverse. Both directions must be
   idempotent — re-running `up` on an already-migrated schema, or `down` on
   an already-reverted one, is a no-op.
5. If the migration adds or changes a template/lookup table also mirrored
   in `shared/` headers (per PLAN.md T-0043), note that the corresponding
   `shared/` header update is a dependency of this card, not a follow-up.
6. Hand off to the normal `tdd` loop: the migration's up/down/up idempotency
   check (via `docker compose` Postgres) *is* its test, written and run
   before the migration is considered done.
