import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/lib/db/connection.js";

/**
 * Regression test for a real incident (T-0345): migrateVerdictArchive.js's `main()` used to run
 * unconditionally at module load (`main().catch(...)` at the bottom of the file, with no
 * `import.meta.url === entry point` guard). Anything that imported the module for its
 * `migrateCard` export -- the only reason a caller other than the CLI itself would ever import
 * it -- silently ran the *entire* CLI migration as a side effect of the import, against whatever
 * BOARD_TASK_STORE/BOARD_DB_PATH happened to be set in the ambient environment. In this
 * project's actual Agent Runner shell, that env is BOARD_TASK_STORE=db pointed at the live
 * board.db -- so a plain `import { migrateCard } from "../scripts/migrateVerdictArchive.js"`
 * mass-migrated the entire live task corpus instead of touching nothing.
 *
 * Isolated in its own file (not migrateVerdictArchive.cli.test.js) because it mocks
 * ../src/lib/db/connection.js's openDb -- if that mock applied file-wide it would break every
 * other test here that constructs a real DbTaskStore. BOARD_TASK_STORE is forced to "db" so this
 * test exercises (and neutralizes) the exact path that caused the incident regardless of what the
 * ambient shell happens to have set.
 */
vi.mock("../src/lib/db/connection.js", () => ({
  openDb: vi.fn(() => {
    throw new Error("openDb must never be called just by importing migrateVerdictArchive.js for migrateCard");
  })
}));

const ORIGINAL_ARGV = process.argv;
const ORIGINAL_BOARD_TASK_STORE = process.env.BOARD_TASK_STORE;

beforeEach(() => {
  process.env.BOARD_TASK_STORE = "db";
  // Simulate the real failure mode: imported from another module's code, not run as
  // `node migrateVerdictArchive.js` -- argv[1] is the importing process's own entry point.
  process.argv = [ORIGINAL_ARGV[0], "/some/other/entrypoint.js"];
});

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
  if (ORIGINAL_BOARD_TASK_STORE === undefined) {
    delete process.env.BOARD_TASK_STORE;
  } else {
    process.env.BOARD_TASK_STORE = ORIGINAL_BOARD_TASK_STORE;
  }
});

describe("migrateVerdictArchive.js: importing it for migrateCard must not run the CLI", () => {
  it("does not open the db (or do anything else) just from being imported", async () => {
    const mod = await import("../scripts/migrateVerdictArchive.js");
    expect(typeof mod.migrateCard).toBe("function");

    // Flush pending microtasks/macrotasks: if main() ran as an import side effect, its
    // internal openDb() call (and the .catch() that would swallow its resulting rejection)
    // needs a tick to actually happen.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(openDb).not.toHaveBeenCalled();
  });
});
