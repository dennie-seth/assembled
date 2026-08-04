#!/usr/bin/env node
import { validateBacklog, readBacklogEntries, DEFAULT_TASKS_DIR } from "../src/lib/backlogValidator.js";

async function main() {
  const entries = await readBacklogEntries(DEFAULT_TASKS_DIR);
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
