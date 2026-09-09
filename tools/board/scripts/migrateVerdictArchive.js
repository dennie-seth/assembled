#!/usr/bin/env node
/**
 * One-off / re-runnable migration (T-0345): pulls the accumulated `## Validation: FAIL (ts)` /
 * `## Validation: PASS (ts)` sections out of existing task card bodies -- the old
 * runOrchestrator.js appendNote-based history -- into the per-card verdict archive
 * (tools/board/src/lib/verdictArchive.js), losslessly, and rewrites the card file with the
 * stripped body. Safe to re-run: a card with nothing left to archive reports archivedCount: 0
 * and its file is left byte-identical.
 *
 * Prints one JSON line per migrated card: {id, beforeBytes, afterBytes, archivedCount}.
 *
 * usage: node tools/board/scripts/migrateVerdictArchive.js [id...] [--tasks-dir <dir>]
 *   With no ids given, migrates every *.md file directly under --tasks-dir (default: repo tasks/).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTask, serializeTask } from "../src/lib/taskParser.js";
import { migrateBodyVerdicts, appendVerdictEntry } from "../src/lib/verdictArchive.js";

const DEFAULT_TASKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tasks");

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

export async function migrateCard(tasksDir, id) {
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

async function resolveTargets(tasksDir, ids) {
  if (ids.length > 0) return ids;
  const entries = await fs.readdir(tasksDir);
  return entries.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
}

async function main() {
  const { ids, tasksDir } = parseArgs(process.argv.slice(2));
  const targets = await resolveTargets(tasksDir, ids);
  for (const id of targets) {
    const result = await migrateCard(tasksDir, id);
    console.log(JSON.stringify(result));
  }
}

main().catch((err) => {
  console.error(`migrateVerdictArchive: ${err.message}`);
  process.exitCode = 1;
});
