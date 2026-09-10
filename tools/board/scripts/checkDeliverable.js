#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { parseTask } from "../src/lib/taskParser.js";
import { checkDeliverable } from "../src/lib/deliverableCheck.js";
import { readTaskBodyAtMergeBase } from "../src/lib/gitTaskHistory.js";
import { readTaskBodyBeforeRun } from "../src/lib/db/dbTaskHistory.js";
import { FINDING_HEADING } from "../src/lib/preRegisteredFinding.js";
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
 *
 * `db` is passed in (rather than opened here) so the caller can reuse the same connection for
 * `readTaskBodyBeforeRun` afterwards -- opening a second connection would work too (SQLite/WAL
 * tolerates it) but there's no reason to.
 */
async function loadTaskAndAttachmentsDir(id, db) {
  if (db) {
    const store = new DbTaskStore(db);
    const task = await store.get(id);
    const attachmentsDir = path.join(path.dirname(resolveDbPath()), "attachments");
    return { task, attachmentsDir };
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

  const isDbMode = (process.env.BOARD_TASK_STORE || "fs") === "db";
  const db = isDbMode ? openDb() : null;
  try {
    const { task, attachmentsDir } = await loadTaskAndAttachmentsDir(id, db);
    if (!task) {
      console.error(`${id}: no such task found.`);
      process.exitCode = 1;
      return;
    }

    // T-0342: the "before this run" snapshot the pre-registered-finding route is pinned to.
    // fs-mode reads it from git (the merge-base with `develop`); db-mode has no git-committed
    // task history, so it's reconstructed from card_events instead (see dbTaskHistory.js) --
    // still bounded to strictly before the run, never the current live body.
    const beforeBody = isDbMode
      ? readTaskBodyBeforeRun(db, id)
      : await readTaskBodyAtMergeBase({ cwd: REPO_ROOT, id, baseRef: "develop" });

    const report = await checkDeliverable(task, { attachmentsDir, requireArtifact, beforeBody, repoRoot: REPO_ROOT });

    if (!report.applicable) {
      console.log(`${id}: deliverable_type is "${task.deliverable_type}", not "artifact" -- nothing to check.`);
      return;
    }
    if (report.ok) {
      if (task.attachments.length > 0) {
        console.log(
          `${id}: deliverable check passed -- ${task.attachments.length} attachment(s) recorded and present on disk.`
        );
      } else {
        console.log(
          `${id}: deliverable check passed -- no promoted artifact, but a pre-registered experiment (checked against the card's body before this run) produced a decisive finding with committed evidence (see the card's "${FINDING_HEADING}" section).`
        );
      }
      return;
    }

    console.error(`${id}: deliverable check FAILED.\n`);
    for (const message of report.errors) {
      console.error(`  ${message}`);
    }
    process.exitCode = 1;
  } finally {
    if (db) db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
