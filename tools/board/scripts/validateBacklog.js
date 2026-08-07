#!/usr/bin/env node
import { validateBacklog, readBacklogEntries, backlogEntriesFromTasks, DEFAULT_TASKS_DIR } from "../src/lib/backlogValidator.js";
import { openDb } from "../src/lib/db/connection.js";
import { DbTaskStore } from "../src/lib/db/dbTaskStore.js";

/**
 * BOARD_TASK_STORE=db reads the live SQLite backlog instead of tasks/*.md -- the
 * db-mode entrypoint docs/design/cards-to-database.md's Phase 2 calls for. Default (unset/"fs")
 * is unchanged from before this refactor.
 */
async function loadEntries() {
  if ((process.env.BOARD_TASK_STORE || "fs") === "db") {
    const db = openDb();
    try {
      const store = new DbTaskStore(db);
      return backlogEntriesFromTasks(await store.list());
    } finally {
      db.close();
    }
  }
  return readBacklogEntries(DEFAULT_TASKS_DIR);
}

async function main() {
  const entries = await loadEntries();
  const report = await validateBacklog(entries);

  if (report.ok) {
    console.log(`Backlog validation passed: ${report.taskCount} task(s) checked.`);
    return;
  }

  console.error(
    `Backlog validation FAILED: ${report.errors.length} error(s) across ${report.taskCount} parsed task(s).\n`
  );
  for (const { file, message } of report.errors) {
    console.error(`  ${file}: ${message}`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
