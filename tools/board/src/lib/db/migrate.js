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
    const applyOne = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString()
      );
    });
    applyOne();
  }

  return files;
}
