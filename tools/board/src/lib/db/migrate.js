import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SCHEMA_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);`;

/**
 * Applies every *.sql file in `migrationsDir`, in filename order, that isn't
 * already recorded in schema_migrations. Each migration runs in its own
 * transaction alongside its schema_migrations bookkeeping row, so a failed
 * migration never leaves a half-applied schema recorded as applied.
 *
 * `foreign_keys` is toggled OFF around each migration's transaction (never
 * inside one -- SQLite treats that pragma as a no-op mid-transaction) and
 * back ON after. This is required for any migration that rebuilds a table
 * other tables reference via FK (SQLite has no ALTER TABLE for CHECK
 * constraints, so widening one means CREATE new + copy + DROP old + RENAME --
 * see 0002_add_generic_agent.sql): with foreign_keys left ON, dropping the
 * old table performs an implicit cascading DELETE first, wiping every child
 * row (task_dependencies/comments/attachments) before the rename ever
 * happens. Off is a no-op for migrations that don't touch such a table.
 */
export function runMigrations(db, migrationsDir) {
  db.exec(SCHEMA_MIGRATIONS_TABLE_SQL);
  const applied = new Set(
    db.prepare("SELECT id FROM schema_migrations").all().map((row) => row.id)
  );
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    const wasForeignKeysOn = db.pragma("foreign_keys", { simple: true }) === 1;
    if (wasForeignKeysOn) db.pragma("foreign_keys = OFF");
    try {
      const applyOne = db.transaction(() => {
        db.exec(sql);
        db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
          file,
          new Date().toISOString()
        );
      });
      applyOne();
    } finally {
      if (wasForeignKeysOn) db.pragma("foreign_keys = ON");
    }
  }

  return files;
}
