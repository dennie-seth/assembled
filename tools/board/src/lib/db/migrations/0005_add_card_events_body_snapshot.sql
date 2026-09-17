-- T-0342: db-mode "before this run" body snapshot, the DB-store equivalent of git history.
--
-- fs-mode reconstructs a card's body "before this run" with a merge-base `git show` against the
-- task's committed markdown file (gitTaskHistory.js's readTaskBodyAtMergeBase). DB-mode tasks are
-- never committed to git at all (dbTaskStore.js's whole premise), so card_events -- already this
-- store's audit trail, replacing git history per 0001_init.sql's own comment -- is the only place
-- that history can live. Until now it recorded only *which* fields changed (the `changed` JSON
-- list), never the resulting content, so there was no way to answer "what did body actually say
-- right before this run started" in db mode -- checkDeliverable.js hardcoded beforeBody = "" for
-- BOARD_TASK_STORE=db as a result, making the whole T-0342 finding-with-evidence route dead code
-- for every live card (db mode is production -- see boardServer.js).
--
-- This column stores the FULL resulting body value on every event row (not just update rows where
-- body itself changed, and not just a diff) -- src/lib/db/dbTaskHistory.js's
-- readTaskBodyBeforeRun() reads a specific historical event's `body` column directly rather than
-- replaying a diff chain. Simple ADD COLUMN with a non-volatile default: card_events has no FK
-- other tables reference and no CHECK constraint being widened, so this needs none of 0002/0004's
-- create+copy+drop+rename recipe.

ALTER TABLE card_events ADD COLUMN body TEXT NOT NULL DEFAULT '';
