// The test process must never inherit the live board's store configuration.
//
// `claudeCliRunner.js`'s AGENT_ENV_ALLOWLIST deliberately forwards BOARD_TASK_STORE and
// BOARD_DB_PATH to child `claude` CLIs (PR #230) so an agent's own curl/API calls see the same
// board the service does. The unintended consequence: when that agent runs `npx vitest`, every
// test inherits them too, `startBoardServer`'s `taskStoreKind` defaults to "db", `openDb()`
// falls through to DEFAULT_DB_PATH, and the suite runs against the LIVE board database.
//
// That is what reaped six live cards on 2026-09-04 (see boardOwnership.test.js), and it is also
// the long-standing "known BOARD_TASK_STORE=db environmental baseline" -- the boardServer store
// selection tests that expect FsTaskStore and get DbTaskStore. Same root cause, two symptoms.
//
// test/setup/envIsolation.js runs as a vitest `setupFiles` entry, i.e. inside every worker
// process before any test module is imported.
import { describe, it, expect } from "vitest";

describe("test env isolation", () => {
  it("does not inherit BOARD_TASK_STORE from the board service", () => {
    expect(process.env.BOARD_TASK_STORE).toBeUndefined();
  });

  it("does not inherit BOARD_DB_PATH from the board service", () => {
    expect(process.env.BOARD_DB_PATH).toBeUndefined();
  });

  it("leaves a test free to set them deliberately for its own scope", () => {
    process.env.BOARD_TASK_STORE = "db";
    expect(process.env.BOARD_TASK_STORE).toBe("db");
    delete process.env.BOARD_TASK_STORE;
  });
});
