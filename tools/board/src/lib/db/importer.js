import { promises as fs } from "node:fs";
import path from "node:path";
import { readBacklogEntries, validateBacklog, DEFAULT_TASKS_DIR } from "../backlogValidator.js";
import { parseTask } from "../taskParser.js";
import { openDb, DEFAULT_DB_PATH } from "./connection.js";
import { DbTaskStore } from "./dbTaskStore.js";

async function fileExists(p) {
  return fs.access(p).then(
    () => true,
    () => false
  );
}

/**
 * One-time importer: tasks/*.md (+ tasks/attachments/<id>/) -> the SQLite store.
 * docs/design/cards-to-database.md, "Migration". Read-only against `tasksDir` in every mode --
 * dry-run and --commit alike never write, rename, or delete anything under it.
 *
 * `commit: false` (the default) reports what WOULD be imported -- task/comment/attachment
 * counts, attachment byte total, and any parse/validation/missing-file problems -- and returns
 * without ever creating or opening a database file. `commit: true` performs the same checks
 * first and, only if they're all clean, backs up any pre-existing db file to a timestamped
 * `.bak-<ISO>` path, copies attachment files into `<dataDir>/attachments/<id>/`, then writes
 * every task/dependency/comment/attachment row inside a single transaction (id collisions or
 * any other DB error roll the whole import back -- fail-closed, matching this repo's existing
 * validateBacklog/checkPlannerDiffGuard convention), and finally seeds id_allocator to the max
 * imported task id.
 */
export async function importTasks({
  tasksDir = DEFAULT_TASKS_DIR,
  dbPath = process.env.BOARD_DB_PATH || DEFAULT_DB_PATH,
  dataDir = path.dirname(dbPath),
  commit = false
} = {}) {
  const entries = await readBacklogEntries(tasksDir);
  const backlogReport = await validateBacklog(entries);
  const errors = [...backlogReport.errors];

  const tasks = backlogReport.ok ? entries.map(({ raw }) => parseTask(raw)) : [];

  let commentCount = 0;
  let attachmentCount = 0;
  let attachmentTotalBytes = 0;
  const attachmentSources = new Map(); // task id -> [{ filename, sourcePath }]

  for (const task of tasks) {
    commentCount += task.comments.length;
    attachmentCount += task.attachments.length;
    const sources = [];
    for (const attachment of task.attachments) {
      const sourcePath = path.join(tasksDir, "attachments", task.id, attachment.filename);
      let stat;
      try {
        stat = await fs.stat(sourcePath);
      } catch {
        errors.push({
          file: `${task.id}.md`,
          message: `attachment "${attachment.filename}" is listed in frontmatter but no file exists at ${sourcePath}`
        });
        continue;
      }
      attachmentTotalBytes += stat.size;
      sources.push({ filename: attachment.filename, sourcePath });
    }
    attachmentSources.set(task.id, sources);
  }

  const report = {
    ok: errors.length === 0,
    taskCount: tasks.length,
    commentCount,
    attachmentCount,
    attachmentTotalBytes,
    errors
  };

  if (!report.ok || !commit) {
    return report;
  }

  if (await fileExists(dbPath)) {
    const backupPath = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.copyFile(dbPath, backupPath);
  }

  for (const [taskId, sources] of attachmentSources) {
    if (sources.length === 0) continue;
    const destDir = path.join(dataDir, "attachments", taskId);
    await fs.mkdir(destDir, { recursive: true });
    for (const { filename, sourcePath } of sources) {
      await fs.copyFile(sourcePath, path.join(destDir, filename));
    }
  }

  const db = openDb(dbPath);
  try {
    const store = new DbTaskStore(db);
    const maxSeq = tasks.reduce((max, task) => {
      const match = /^T-(\d+)$/.exec(task.id);
      return match ? Math.max(max, Number.parseInt(match[1], 10)) : max;
    }, 0);

    const runImport = db.transaction(() => {
      for (const task of tasks) {
        const exists = db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(task.id);
        if (exists) {
          throw new Error(`Task ${task.id} already exists in the target database`);
        }
        store._insertTaskRowsSync(task, "importer");
      }
      db.prepare("UPDATE id_allocator SET next_seq = MAX(next_seq, ?)").run(maxSeq);
    });
    runImport();
  } finally {
    db.close();
  }

  return report;
}
