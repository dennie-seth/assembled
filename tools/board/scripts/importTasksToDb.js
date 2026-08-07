#!/usr/bin/env node
import path from "node:path";
import { DEFAULT_TASKS_DIR } from "../src/lib/backlogValidator.js";
import { DEFAULT_DB_PATH } from "../src/lib/db/connection.js";
import { importTasks } from "../src/lib/db/importer.js";

function parseArgs(argv) {
  const args = {
    tasksDir: DEFAULT_TASKS_DIR,
    dbPath: process.env.BOARD_DB_PATH || DEFAULT_DB_PATH,
    dataDir: null,
    commit: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tasks-dir") {
      args.tasksDir = argv[++i];
    } else if (arg === "--db-path") {
      args.dbPath = argv[++i];
    } else if (arg === "--data-dir") {
      args.dataDir = argv[++i];
    } else if (arg === "--commit") {
      args.commit = true;
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  args.dataDir = args.dataDir || path.dirname(args.dbPath);
  return args;
}

async function main() {
  const { tasksDir, dbPath, dataDir, commit } = parseArgs(process.argv.slice(2));
  const mode = commit ? "--commit" : "--dry-run (default; pass --commit to actually write)";

  console.log(`Importing ${tasksDir} -> ${dbPath} [${mode}]`);
  const report = await importTasks({ tasksDir, dbPath, dataDir, commit });

  console.log(
    `Tasks: ${report.taskCount}  Comments: ${report.commentCount}  ` +
      `Attachments: ${report.attachmentCount} (${report.attachmentTotalBytes} bytes)`
  );

  if (!report.ok) {
    console.error(`\nImport FAILED: ${report.errors.length} problem(s), nothing was written.\n`);
    for (const { file, message } of report.errors) {
      console.error(`  ${file}: ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  if (!commit) {
    console.log("\nDry run OK -- nothing was written. Re-run with --commit to import for real.");
    return;
  }

  console.log(`\nImport committed to ${dbPath}.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
