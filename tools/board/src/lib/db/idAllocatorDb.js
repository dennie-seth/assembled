import { openDb, DEFAULT_DB_PATH } from "./connection.js";

function formatId(n) {
  return `T-${String(n).padStart(4, "0")}`;
}

/**
 * DB-backed replacement for IdAllocator (src/lib/idAllocator.js). A single row in
 * id_allocator holds the last-issued sequence number; allocate() increments it inside one
 * transaction. Unlike the fs allocator, this needs no promise queue to serialize concurrent
 * callers and no git-history/working-tree scan to reconstruct the max -- better-sqlite3's
 * synchronous API plus SQLite's single-writer model already make each transaction atomic and
 * ordered, and there's exactly one database, not one working tree per git worktree.
 */
export class IdAllocatorDb {
  constructor(dbOrPath = DEFAULT_DB_PATH) {
    if (typeof dbOrPath === "string") {
      this.db = openDb(dbOrPath);
      this._ownsDb = true;
    } else {
      this.db = dbOrPath;
      this._ownsDb = false;
    }
  }

  close() {
    if (this._ownsDb) this.db.close();
  }

  async allocate() {
    const db = this.db;
    const next = db.transaction(() => {
      const row = db.prepare("SELECT next_seq FROM id_allocator").get();
      const nextSeq = row.next_seq + 1;
      db.prepare("UPDATE id_allocator SET next_seq = ?").run(nextSeq);
      return nextSeq;
    })();
    return formatId(next);
  }
}
