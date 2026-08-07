#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_DB_PATH } from "../src/lib/db/connection.js";
import { backupDb } from "../src/lib/db/backup.js";

function parseArgs(argv) {
  const args = { dbPath: process.env.BOARD_DB_PATH || DEFAULT_DB_PATH, outDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db-path") {
      args.dbPath = argv[++i];
    } else if (arg === "--out-dir") {
      args.outDir = argv[++i];
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  args.outDir = args.outDir || path.join(path.dirname(args.dbPath), "backups");
  return args;
}

function timestampedBackupPath(outDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(outDir, `board-${stamp}.db`);
}

async function main() {
  const { dbPath, outDir } = parseArgs(process.argv.slice(2));

  // Open read-only: a backup must never be the thing that starts writing to the live db, and
  // this also lets it run safely even while the real board server holds the write connection.
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  mkdirSync(outDir, { recursive: true });
  const destPath = timestampedBackupPath(outDir);

  await backupDb(db, destPath);
  db.close();

  console.log(`Backed up ${dbPath} -> ${destPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
