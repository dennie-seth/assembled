-- T-0042: trivial first migration. Every table in docs/design/04-data-model.md
-- (identity, item_instance, offering, ...) uses a UUID primary key, so
-- pgcrypto (gen_random_uuid()) is the one piece of real schema groundwork
-- worth landing before the full model does. Idempotent: CREATE EXTENSION IF
-- NOT EXISTS is a no-op on a second run.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
