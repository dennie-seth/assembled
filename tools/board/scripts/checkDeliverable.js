#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { parseTask } from "../src/lib/taskParser.js";
import { checkDeliverable } from "../src/lib/deliverableCheck.js";
import { openDb, resolveDbPath } from "../src/lib/db/connection.js";
import { DbTaskStore } from "../src/lib/db/dbTaskStore.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TASKS_DIR = path.join(REPO_ROOT, "tasks");

/**
 * BOARD_TASK_STORE=db reads the live SQLite task (and resolves the on-disk attachments
 * directory to `<dataDir>/attachments/`, mirroring httpApi.js's own `attachmentsRootDir`)
 * instead of `tasks/<id>.md` / `tasks/attachments/` -- same pattern as validateBacklog.js
 * and checkPlannerDiffGuard.js. Before this, a DB-mode card (the live board's mode since the
 * cards-to-database cutover -- almost every card created since then has no `tasks/<id>.md`
 * file at all) made this script ENOENT-crash outright, so the reviewer's own mandated
 * `checkDeliverable.js <id>` check could never actually run for those cards.
 */
async function loadTaskAndAttachmentsDir(id) {
  if ((process.env.BOARD_TASK_STORE || "fs") === "db") {
    const db = openDb();
    try {
      const store = new DbTaskStore(db);
      const task = await store.get(id);
      const attachmentsDir = path.join(path.dirname(resolveDbPath()), "attachments");
      return { task, attachmentsDir };
    } finally {
      db.close();
    }
  }
  let task;
  try {
    const raw = await fs.readFile(path.join(TASKS_DIR, `${id}.md`), "utf8");
    task = parseTask(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      task = null;
    } else {
      throw err;
    }
  }
  return { task, attachmentsDir: path.join(TASKS_DIR, "attachments") };
}

async function main() {
  const id = process.argv[2];
  const requireArtifact = process.argv.slice(3).includes("--require-artifact");
  if (!id) {
    console.error("Usage: node checkDeliverable.js <T-NNNN> [--require-artifact]");
    process.exitCode = 1;
    return;
  }

  const { task, attachmentsDir } = await loadTaskAndAttachmentsDir(id);
  if (!task) {
    console.error(`${id}: no such task found.`);
    process.exitCode = 1;
    return;
  }

  const report = await checkDeliverable(task, { attachmentsDir, requireArtifact });

  if (!report.applicable) {
    console.log(`${id}: deliverable_type is "${task.deliverable_type}", not "artifact" -- nothing to check.`);
    return;
  }
  if (report.ok) {
    console.log(
      `${id}: deliverable check passed -- ${task.attachments.length} attachment(s) recorded and present on disk.`
    );
    return;
  }

  console.error(`${id}: deliverable check FAILED.\n`);
  for (const message of report.errors) {
    console.error(`  ${message}`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
