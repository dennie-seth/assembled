#!/usr/bin/env node
/**
 * Exports the board's approval record to a committed ledger the CI drift gate can read.
 *
 *   node tools/board/scripts/exportApprovalLedger.js [outPath]
 *
 * Run this on the board host, where the live task store is reachable, and commit the result.
 * `checkApprovalProvenanceDrift.js` consults the live store first and falls back to this file
 * only for ids the live store cannot resolve -- so on the board the ledger is inert, and in CI
 * (where `tasks/*.md` stops at T-0222 and the db is unreachable) it is the data source.
 *
 * This does not create or alter approvals. It is a read-only projection of what the board
 * already records; the board stays the single source of truth (T-0286, DL-27).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { openDb } from "../src/lib/db/connection.js";
import { DbTaskStore } from "../src/lib/db/dbTaskStore.js";
import { buildApprovalLedger } from "../src/lib/approvalLedger.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TASKS_DIR = process.env.BOARD_TASKS_DIR || path.join(REPO_ROOT, "tasks");
const DEFAULT_OUT = path.join(REPO_ROOT, "tools", "board", "approval-ledger.json");

async function loadTasks() {
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
  const outPath = process.argv[2] || DEFAULT_OUT;
  const tasks = await loadTasks();
  if (!tasks.length) {
    console.error("exportApprovalLedger: the task store returned no cards -- refusing to write an empty ledger.");
    process.exitCode = 1;
    return;
  }
  const ledger = buildApprovalLedger(tasks);
  await fs.writeFile(outPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  const gated = ledger.cards.filter((c) => c.requires_approval).length;
  const approved = ledger.cards.filter((c) => c.requires_approval && c.approved_by).length;
  console.log(
    `exportApprovalLedger: wrote ${ledger.cards.length} card(s) to ${outPath} ` +
      `(${gated} gated, ${approved} of those approved).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
