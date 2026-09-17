#!/usr/bin/env node
/**
 * One-off / re-runnable migration (T-0345): pulls the accumulated `## Validation: FAIL (ts)` /
 * `## Validation: PASS (ts)` sections out of existing task card bodies -- the old
 * runOrchestrator.js appendNote-based history -- into the per-card verdict archive
 * (tools/board/src/lib/verdictArchive.js), losslessly, and rewrites the card body with the
 * stripped version. Safe to re-run: a card with nothing left to archive reports
 * archivedCount: 0 and its stored body is left byte-identical.
 *
 * Reads/writes card bodies through the same task-store abstraction runOrchestrator.js and
 * checkDeliverable.js already use: BOARD_TASK_STORE=db (the live board's mode -- see
 * checkDeliverable.js's loadTaskAndAttachmentsDir) routes through DbTaskStore against
 * BOARD_DB_PATH/DEFAULT_DB_PATH instead of tasks/<id>.md. The verdict archive itself always
 * lives on disk under --tasks-dir/.verdicts/, in both modes -- the same precedent
 * runOrchestrator.js's own `tasksDir` default already sets regardless of taskStoreKind.
 *
 * Prints one JSON line per migrated card: {id, beforeBytes, afterBytes, archivedCount}.
 *
 * usage: node tools/board/scripts/migrateVerdictArchive.js [id...] [--tasks-dir <dir>]
 *   With no ids given: fs mode migrates every *.md file directly under --tasks-dir (default:
 *   repo tasks/); db mode migrates every card in the store.
 *
 * T-0259 migration result (the real card, not the synthetic ~270 KB fixture the test suite
 * exercises): this session's run against the live db-mode store archived 25 verdict rounds and
 * measurably shrank the stored body. Numbers below are derived from the pre-incident backup
 * scripts/backupDb.js took at ~/.local/share/assembled-board/backups/board-2026-09-09T16-54-13-681Z.db
 * (taken before any live-db command ran that session -- see b4d1bce's commit message) compared
 * against the current live board.db, both read directly with better-sqlite3:
 *   beforeBytes: 296746 (296554 chars)
 *   afterBytes:  28934  (28761 chars)
 *   archivedCount: 25 (tasks/.verdicts/T-0259.jsonl line count in the production repo)
 *   reduction: 267812 bytes, 90.2%
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseTask, serializeTask } from "../src/lib/taskParser.js";
import { migrateBodyVerdicts, appendVerdictEntry } from "../src/lib/verdictArchive.js";
import { openDb } from "../src/lib/db/connection.js";
import { DbTaskStore } from "../src/lib/db/dbTaskStore.js";

const DEFAULT_TASKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tasks");

function isDbMode() {
  return (process.env.BOARD_TASK_STORE || "fs") === "db";
}

function parseArgs(argv) {
  const ids = [];
  let tasksDir = DEFAULT_TASKS_DIR;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--tasks-dir") {
      tasksDir = path.resolve(argv[++i]);
    } else {
      ids.push(argv[i]);
    }
  }
  return { ids, tasksDir };
}

async function migrateCardViaStore(store, tasksDir, id) {
  const task = await store.get(id);
  if (!task) {
    throw new Error(`Task ${id} not found in db store`);
  }
  const beforeBytes = Buffer.byteLength(task.body ?? "", "utf8");

  const { body, entries } = migrateBodyVerdicts(task.body ?? "");
  for (const entry of entries) {
    await appendVerdictEntry(tasksDir, id, entry);
  }
  if (entries.length > 0) {
    await store.update(id, { body });
  }

  return { id, beforeBytes, afterBytes: Buffer.byteLength(body, "utf8"), archivedCount: entries.length };
}

async function migrateCardOnDisk(tasksDir, id) {
  const filePath = path.join(tasksDir, `${id}.md`);
  const raw = await fs.readFile(filePath, "utf8");
  const task = parseTask(raw);
  const beforeBytes = Buffer.byteLength(raw, "utf8");

  const { body, entries } = migrateBodyVerdicts(task.body);
  for (const entry of entries) {
    await appendVerdictEntry(tasksDir, id, entry);
  }

  const serialized = serializeTask({ ...task, body });
  await fs.writeFile(filePath, serialized, "utf8");

  return { id, beforeBytes, afterBytes: Buffer.byteLength(serialized, "utf8"), archivedCount: entries.length };
}

export async function migrateCard(tasksDir, id, { store } = {}) {
  return store ? migrateCardViaStore(store, tasksDir, id) : migrateCardOnDisk(tasksDir, id);
}

async function resolveTargets(tasksDir, ids, store) {
  if (ids.length > 0) return ids;
  if (store) {
    const tasks = await store.list();
    return tasks.map((task) => task.id);
  }
  const entries = await fs.readdir(tasksDir);
  return entries.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
}

async function main() {
  const { ids, tasksDir } = parseArgs(process.argv.slice(2));

  let db;
  let store;
  if (isDbMode()) {
    db = openDb();
    store = new DbTaskStore(db);
  }

  try {
    const targets = await resolveTargets(tasksDir, ids, store);
    for (const id of targets) {
      const result = await migrateCard(tasksDir, id, { store });
      console.log(JSON.stringify(result));
    }
  } finally {
    if (db) db.close();
  }
}

// Only run the CLI when this file is the actual entry point (`node migrateVerdictArchive.js
// ...`) -- never merely as a side effect of some other module importing it for its exported
// migrateCard. Without this guard, an in-process `import { migrateCard } from
// "./migrateVerdictArchive.js"` runs main() unconditionally against whatever
// BOARD_TASK_STORE/BOARD_DB_PATH the ambient process happens to have, which is exactly how this
// migrated ~200 unrelated live cards in one shot during this card's own implementation.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`migrateVerdictArchive: ${err.message}`);
    process.exitCode = 1;
  });
}
