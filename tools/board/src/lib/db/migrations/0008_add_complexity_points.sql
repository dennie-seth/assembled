-- T-0368: complexity_points, a human planning-only signal (spec §2, §10 step 2 -- planning
-- complexity and machine execution cost are two separate axes; this is only the first). Nullable:
-- NULL means "not yet scored," which is itself a meaningful, displayed state (board columns show
-- an "unscored" count), not a fallback to some default point value. Restricted to the Fibonacci
-- steps {1,2,3,5,8,13,21} -- validated in taskParser.js's validateTask, same precedent as
-- max_attempts (0006) and round (0007): no DB-level CHECK constraint duplicating the business
-- rule, so this stays a plain ADD COLUMN and never triggers the FK-cascade-on-DROP rebuild hazard
-- documented in migrate.js's runMigrations() / 0002_add_generic_agent.sql.
--
-- Plain ADD COLUMN, no default needed: SQLite gives every existing row NULL for a new nullable
-- column with no DEFAULT clause, so existing cards keep working unchanged.

ALTER TABLE tasks ADD COLUMN complexity_points INTEGER;
