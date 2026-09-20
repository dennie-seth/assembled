import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TaskStore,
  StaleWriteError,
  DependencyNotSatisfiedError,
  DependencyLockSetUnstableError,
  findMismatchedExpectedFields,
  findUnsatisfiedDependencies
} from "./taskStore.js";
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

/** Order-independent id-set equality -- used to compare a candidate's freshly re-read
 * `depends_on` against the ids a guarded FS write actually locked (see `update`'s
 * `requireDependenciesSatisfied` branch, T-0384 FIX ROUND 6).
 */
function sameIdSet(a, b) {
  const setA = new Set(a ?? []);
  const setB = new Set(b ?? []);
  if (setA.size !== setB.size) return false;
  for (const value of setA) {
    if (!setB.has(value)) return false;
  }
  return true;
}

/** Bounded retry limit for `update`'s dependency-lock-set correction loop -- see its comment. */
const MAX_DEPENDENCY_LOCK_ATTEMPTS = 5;

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
    //
    // T-0384 FIX ROUND 5 (Codex round-2 review 2026-09-19, P2): a `requireDependenciesSatisfied`
    // update used to acquire only the CANDIDATE's own lock, so a separate write to a DEPENDENCY id
    // -- a different entry in this same map -- could still land between the guarded read and the
    // candidate's write. `update()` now locks the candidate id together with every id in the
    // `depends_on` list it is about to check, via `_withLocks` below, so a dependency write
    // through this store instance cannot interleave with a guarded ready operation checking it.
    //
    // T-0384 FIX ROUND 6 (Chat round-3 review 2026-09-19, P2): FIX ROUND 5 still chose WHICH ids
    // to lock from an UNLOCKED peek of `depends_on`, taken before any lock is held -- if
    // `depends_on` itself changed between that peek and lock acquisition, the guard could end up
    // holding yesterday's dependency's lock while evaluating today's real dependency without ever
    // locking it. `update()` now re-reads `depends_on` fresh INSIDE the lock it just acquired and
    // compares it against the ids it actually locked; a mismatch releases the lock and retries
    // with the corrected set (bounded by `MAX_DEPENDENCY_LOCK_ATTEMPTS`, refusing with
    // `DependencyLockSetUnstableError` rather than looping forever if it never settles). This does
    // NOT rely on a caller-supplied `expected.depends_on` -- the comparison is always against a
    // fresh read taken by `update` itself, so `requireDependenciesSatisfied: true` is safe on its
    // own with no `expected` at all.
    this._locks = new Map();
  }

  /** Serializes `fn` against any other call already queued for `id`. See the constructor note. */
  async _withLock(id, fn) {
    return this._withLocks([id], fn);
  }

  /**
   * Same guarantee as `_withLock`, generalized to a SET of ids: `fn` runs only once every id in
   * `ids` has drained its own currently-queued work, and no other call sharing any of those ids
   * can start until `fn` settles. Ids are deduped and sorted before use -- not because acquisition
   * order matters for deadlock avoidance here (there is no partial "hold while waiting" step: the
   * predecessor tails for every id are captured and replaced in one synchronous block, with no
   * `await` in between, so two overlapping calls can never each hold one id while waiting on the
   * other) but for deterministic, reviewable behaviour, and so that the two "opposite order"
   * dependency sets in a concurrent pair of guarded writes converge on the same acquisition order.
   */
  async _withLocks(ids, fn) {
    const uniqueSortedIds = [...new Set(ids)].sort();
    const previousTails = uniqueSortedIds.map((id) => this._locks.get(id) ?? Promise.resolve());
    const run = Promise.all(previousTails).then(fn, fn);
    const settledTail = run.then(
      () => undefined,
      () => undefined
    );
    for (const id of uniqueSortedIds) {
      this._locks.set(id, settledTail);
    }
    try {
      return await run;
    } finally {
      // Only clear an entry if nothing else has queued behind us in the meantime.
      for (const id of uniqueSortedIds) {
        if (this._locks.get(id) === settledTail) {
          this._locks.delete(id);
        }
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

  async update(id, updates, { expected, requireDependenciesSatisfied } = {}) {
    for (let attempt = 1; ; attempt += 1) {
      // T-0384 FIX ROUND 5 (Codex round-2 review 2026-09-19, P2): when the write is going to check
      // dependency status, lock those dependency ids TOO, not just `id` -- otherwise a separate
      // write to a dependency (a different entry in `_locks`) could still land between the read
      // below and the write it guards. T-0384 FIX ROUND 6 (Chat round-3 review, P2): this peek is
      // UNLOCKED and can be stale the instant it's taken -- `depends_on` itself may change before
      // the lock below is even acquired, which used to mean the guard could lock the WRONG ids.
      // The re-check inside the lock, below, catches that and retries with a corrected set.
      const peekedDependencyIds = requireDependenciesSatisfied
        ? (updates.depends_on ?? (await this.get(id))?.depends_on ?? [])
        : [];
      const lockIds = [id, ...peekedDependencyIds];
      const outcome = await this._withLocks(lockIds, async () => {
        const existing = await this.get(id);
        if (!existing) {
          throw new Error(`Task ${id} not found`);
        }
        if (updates.id !== undefined && updates.id !== id) {
          throw new Error("Cannot change a task's id via update");
        }

        if (requireDependenciesSatisfied) {
          // Re-read `depends_on` fresh, now that the lock is actually held, and compare it
          // against the ids `lockIds` above locked. A mismatch means the unlocked peek was stale
          // (T-0384 FIX ROUND 6): never evaluate, or write against, a dependency whose lock this
          // attempt doesn't hold -- drop the lock and retry with the now-known-correct set.
          const freshDependencyIds = updates.depends_on ?? existing.depends_on ?? [];
          if (!sameIdSet(freshDependencyIds, peekedDependencyIds)) {
            return { retry: true };
          }
        }

        // The per-id lock above makes this atomic against every other mutating call on the same
        // id serviced by this store instance: no other `create`/`update`/`remove` for `id` can run
        // between this read and the write below.
        assertExpectedMatches(id, expected, existing);
        const merged = { ...existing, ...updates, id };

        // T-0384 FIX ROUND 4 (Codex review 2026-09-19, P2 #2): re-reads each dependency's status
        // here, inside the same per-id lock section, immediately before the write -- not off
        // whatever a caller checked separately beforehand. T-0384 FIX ROUND 5/6: as of the
        // dependency-set check above, this section only ever runs once `lockIds` is confirmed to
        // match `merged.depends_on`, so every id read here is genuinely held. Still
        // in-process/per-instance only (see the constructor note): it does not cover a dependency
        // written by a second `FsTaskStore` instance or another process.
        if (requireDependenciesSatisfied) {
          const statusById = new Map();
          for (const depId of merged.depends_on ?? []) {
            const dep = await this.get(depId);
            statusById.set(depId, dep?.status ?? null);
          }
          const unmet = findUnsatisfiedDependencies(merged.depends_on, statusById);
          if (unmet.length > 0) {
            throw new DependencyNotSatisfiedError(id, unmet);
          }
        }

        await atomicWriteFile(taskPath(this.dir, id), serializeTask(merged));
        return { merged };
      });

      if (outcome.retry) {
        if (attempt >= MAX_DEPENDENCY_LOCK_ATTEMPTS) {
          throw new DependencyLockSetUnstableError(id, MAX_DEPENDENCY_LOCK_ATTEMPTS);
        }
        continue;
      }
      return outcome.merged;
    }
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
