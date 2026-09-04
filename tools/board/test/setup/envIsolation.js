// Runs inside every vitest worker before any test module is imported (vite.config.js
// `test.setupFiles`).
//
// The board service runs with BOARD_TASK_STORE=db, and claudeCliRunner.js's AGENT_ENV_ALLOWLIST
// forwards BOARD_TASK_STORE/BOARD_DB_PATH to child `claude` CLIs on purpose (PR #230) so an
// agent's own API calls address the same board the service does. The unintended consequence is
// that when an agent runs `npx vitest` inside its own card, the tests inherit them too --
// `startBoardServer` defaults `taskStoreKind` to "db", `openDb()` falls through to
// DEFAULT_DB_PATH, and the suite runs against the LIVE board database.
//
// That cost six live card reaps on 2026-09-04 (see test/runner/boardOwnership.test.js) and is
// also the long-running "known BOARD_TASK_STORE=db environmental baseline": the boardServer
// store-selection tests that expect FsTaskStore and get DbTaskStore.
//
// Scrubbing them here makes the suite's store configuration a property of the suite rather than
// of whoever happened to launch it -- `npm test` behaves identically on a developer's shell, in
// CI, and inside an agent run. Tests that want a db store still set it explicitly for their own
// scope, which is why this only clears the inherited value and installs no other policy.
delete process.env.BOARD_TASK_STORE;
delete process.env.BOARD_DB_PATH;
