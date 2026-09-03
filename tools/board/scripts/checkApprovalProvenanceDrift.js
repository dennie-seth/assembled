#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { openDb } from "../src/lib/db/connection.js";
import { DbTaskStore } from "../src/lib/db/dbTaskStore.js";
import { findApprovalDrift } from "../src/lib/approvalProvenanceDrift.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TASKS_DIR = path.join(REPO_ROOT, "tasks");
const DEFAULT_PROVENANCE_PATH = path.join(REPO_ROOT, "ASSET_PROVENANCE.md");

/**
 * CI-enforced backstop for T-0286 (docs/decision-log.md DL-27): `approvalVerdict` made the board
 * the single approval source of truth, but nothing previously caught `ASSET_PROVENANCE.md`'s own
 * prose sitting stale for days the way T-0257's did (approved on the board 2026-08-30, provenance
 * row still read "Not yet approved," blocking T-0243/T-0244/T-0245/T-0246 on a decision already
 * made). Deliberately independent of any agent's own tool grants -- this is a static, git-only
 * read (task files + the committed provenance file), run by CI on every PR that touches either,
 * so the drift is caught mechanically on the next push rather than by a human noticing.
 */
async function loadAllTasks() {
  if ((process.env.BOARD_TASK_STORE || "fs") === "db") {
    const db = openDb();
    try {
      return await new DbTaskStore(db).list();
    } finally {
      db.close();
    }
  }
  return new FsTaskStore(TASKS_DIR).list();
}

async function main() {
  const provenancePath = process.argv[2] || DEFAULT_PROVENANCE_PATH;

  let provenanceText;
  try {
    provenanceText = await fs.readFile(provenancePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log(`${provenancePath}: no such file -- nothing to check.`);
      return;
    }
    throw err;
  }

  const tasks = await loadAllTasks();
  const report = findApprovalDrift({ provenanceText, tasks });

  if (report.ok) {
    console.log(
      `Approval provenance drift check passed against ${provenancePath} (${tasks.length} task(s) cross-checked).`
    );
    return;
  }

  console.error(`Approval provenance drift FAILED against ${provenancePath}: ${report.drifts.length} issue(s).\n`);
  for (const drift of report.drifts) {
    console.error(`  ${drift.taskId} (${drift.kind}): ${drift.message}`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
