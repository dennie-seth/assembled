import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore, StaleWriteError, findMismatchedExpectedFields } from "./taskStore.js";
import { parseTask, serializeTask } from "./taskParser.js";
import { atomicWriteFile } from "./atomicWrite.js";

/** Checks `expected` (a partial field->value map, see findMismatchedExpectedFields) against
 * `current`; throws a StaleWriteError naming every mismatched field on any mismatch.
 */
function assertExpectedMatches(id, expected, current) {
  const mismatches = findMismatchedExpectedFields(expected, current);
  if (mismatches.length > 0) {
    throw new StaleWriteError(id, expected, current, mismatches);
  }
}

const DEFAULT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tasks"
);

function taskPath(dir, id) {
  return path.join(dir, `${id}.md`);
}

export class FsTaskStore extends TaskStore {
  constructor(dir = DEFAULT_DIR) {
    super();
    this.dir = dir;
    // Per-id async mutex (T-0384 FIX ROUND 2, Codex P2 #2, head d81d474c). `update`'s own read of
    // `existing` used to be checked against `expected` and then, separately, overwritten by the
    // write -- a real gap a second, fully-interleaved `update()` call on the SAME id could land a
    // write in. Every mutating call for a given id is now chained onto the previous one for that
    // id, so the read-check-write is atomic against every other writer that goes through THIS
    // `FsTaskStore` instance's own `_locks` map.
    //
    // T-0384 FIX ROUND 3: spelling out the limit precisely, since a prior version of this comment
    // ("atomic against every other writer this store itself services") read more broadly than
    // it is. This lock is in-process and per-instance only: it does not serialize against a
    // second `FsTaskStore` instance pointed at the same `dir` (in this process or another), and it
    // does not serialize against any other process writing the same task file directly (there is
    // no filesystem-level lock, e.g. `flock`, on the task file itself). The same shape of
    // guarantee as `DbTaskStore`'s transaction-based check (see its comment in `dbTaskStore.js`) --
    // atomic against in-process writers sharing the same store instance/connection, no claim
    // beyond that.
    this._locks = new Map();
  }

  /** Serializes `fn` against any other call already queued for `id`. See the constructor note. */
  async _withLock(id, fn) {
    const previousTail = this._locks.get(id) ?? Promise.resolve();
    const run = previousTail.then(fn, fn);
    const settledTail = run.then(
      () => undefined,
      () => undefined
    );
    this._locks.set(id, settledTail);
    try {
      return await run;
    } finally {
      // Only clear the entry if nothing else has queued behind us in the meantime.
      if (this._locks.get(id) === settledTail) {
        this._locks.delete(id);
      }
    }
  }

  async list() {
    await fs.mkdir(this.dir, { recursive: true });
    const entries = await fs.readdir(this.dir);
    const tasks = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const raw = await fs.readFile(path.join(this.dir, entry), "utf8");
      tasks.push(parseTask(raw));
    }
    tasks.sort((a, b) => a.id.localeCompare(b.id));
    return tasks;
  }

  async get(id) {
    try {
      const raw = await fs.readFile(taskPath(this.dir, id), "utf8");
      return parseTask(raw);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  async create(task) {
    return this._withLock(task.id, async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const filePath = taskPath(this.dir, task.id);
      const exists = await fs
        .access(filePath)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        throw new Error(`Task ${task.id} already exists`);
      }
      await atomicWriteFile(filePath, serializeTask(task));
      return task;
    });
  }

  async update(id, updates, { expected } = {}) {
    return this._withLock(id, async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`Task ${id} not found`);
      }
      if (updates.id !== undefined && updates.id !== id) {
        throw new Error("Cannot change a task's id via update");
      }
      // The per-id lock above makes this atomic against every other mutating call on the same
      // id serviced by this store instance: no other `create`/`update`/`remove` for `id` can run
      // between this read and the write below.
      assertExpectedMatches(id, expected, existing);
      const merged = { ...existing, ...updates, id };
      await atomicWriteFile(taskPath(this.dir, id), serializeTask(merged));
      return merged;
    });
  }

  async move(id, status) {
    return this.update(id, { status });
  }

  async remove(id) {
    return this._withLock(id, async () => {
      try {
        await fs.unlink(taskPath(this.dir, id));
      } catch (err) {
        if (err.code === "ENOENT") {
          throw new Error(`Task ${id} not found`);
        }
        throw err;
      }
    });
  }
}
