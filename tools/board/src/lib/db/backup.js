/**
 * Makes a consistent, WAL-safe copy of an open database via SQLite's own online backup API
 * (better-sqlite3's Database#backup, not a raw file copy -- a `cp` mid-write can copy a
 * torn/inconsistent set of pages; the backup API never can, and it runs against a live
 * connection without blocking concurrent readers/writers). Returns once the backup is
 * complete; the source database is left completely untouched.
 */
export async function backupDb(db, destPath) {
  await db.backup(destPath);
  return destPath;
}
