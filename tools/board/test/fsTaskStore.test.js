import { describe, it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore, StaleWriteError, DependencyLockSetUnstableError } from "../src/lib/taskStore.js";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { runTaskStoreContractTests, makeTask } from "./taskStoreContract.js";

describe("TaskStore (abstract interface)", () => {
  it("throws not-implemented for every method when unimplemented", async () => {
    const base = new TaskStore();
    await expect(base.list()).rejects.toThrow(/not implemented/i);
    await expect(base.get("T-0001")).rejects.toThrow(/not implemented/i);
    await expect(base.create(makeTask())).rejects.toThrow(/not implemented/i);
    await expect(base.update("T-0001", {})).rejects.toThrow(/not implemented/i);
    await expect(base.move("T-0001", "ready")).rejects.toThrow(/not implemented/i);
    await expect(base.remove("T-0001")).rejects.toThrow(/not implemented/i);
  });
});

runTaskStoreContractTests("FsTaskStore", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-fstaskstore-"));
  return {
    store: new FsTaskStore(tmpDir),
    dispose: () => fs.rm(tmpDir, { recursive: true, force: true })
  };
});

describe("FsTaskStore atomic writes", () => {
  it("leaves no stray temp files in the tasks dir after create/update/move", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-fstaskstore-atomic-"));
    try {
      const store = new FsTaskStore(tmpDir);
      const task = makeTask();
      await store.create(task);
      await store.update(task.id, { status: "ready" });
      await store.move(task.id, "in-progress");
      const entries = await fs.readdir(tmpDir);
      expect(entries).toEqual(["T-0001.md"]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

/**
 * T-0384 FIX ROUND 2 (Codex P2 #2, head d81d474c): `update`'s old TOCTOU window was "checked
 * against the same `existing` read that's about to be overwritten" (its own comment, since
 * removed) -- a real gap between the read and the write that a second, fully-interleaved
 * `update()` call on the same id could land in. `update` now serializes every call for a given
 * id through a real per-id lock, so the read/check/write is atomic against every other writer
 * this store itself services -- not merely "narrowed", closed.
 */
describe("FsTaskStore conditional-update locking (interleaving regression)", () => {
  it("never lets a concurrent, in-flight second update() start its own read until the first's write has landed", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-fstaskstore-lock-"));
    try {
      const store = new FsTaskStore(tmpDir);
      const task = makeTask({ id: "T-9001", status: "backlog" });
      await store.create(task);

      let releaseFirstRead;
      const gate = new Promise((resolve) => {
        releaseFirstRead = resolve;
      });
      const originalReadFile = fs.readFile.bind(fs);
      let firstReadSeen = false;
      const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        const isTargetRead = String(args[0]).endsWith("T-9001.md");
        if (isTargetRead && !firstReadSeen) {
          firstReadSeen = true;
          await gate; // pauses the first update() call right after it starts reading
        }
        return originalReadFile(...args);
      });

      // The conditional write -- if the lock did not exist, this would read "backlog", pass its
      // precondition, and (after the gate releases) blindly overwrite whatever a concurrent write
      // landed in the meantime.
      const conditionalUpdate = store.update("T-9001", { status: "ready" }, { expected: { status: "backlog" } });

      // Give the event loop a tick so conditionalUpdate has entered its (now-gated) read.
      await new Promise((resolve) => setTimeout(resolve, 10));

      // A second, fully independent, unconditional update -- simulates a human/another process
      // moving the same card to `done` while the first call is still in flight.
      let concurrentSettled = false;
      const concurrentDone = store.update("T-9001", { status: "done" }).then((result) => {
        concurrentSettled = true;
        return result;
      });

      // With the per-id lock in place, the concurrent call cannot even begin its own read (let
      // alone complete) while the first call still holds the lock -- prove it stays pending.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(concurrentSettled).toBe(false);

      releaseFirstRead();
      await conditionalUpdate;
      await concurrentDone;

      // Because the two calls were strictly serialized, the concurrent unconditional write always
      // lands last here and the conditional write never had a chance to race it -- exactly the
      // "must not overwrite done" guarantee, achieved by construction rather than by luck.
      const final = await store.get("T-9001");
      expect(final.status).toBe("done");

      readSpy.mockRestore();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses a conditional write outright when it is the second to land after a real interleaving race", async () => {
    // Same shape, but with the conditional update queued BEHIND the unconditional one, proving
    // the lock's ordering guarantee also makes the conditional check itself meaningful: once
    // serialized, a conditional update queued after a status-changing write correctly observes
    // the new status and is refused, rather than silently reapplying over it.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-fstaskstore-lock-order-"));
    try {
      const store = new FsTaskStore(tmpDir);
      const task = makeTask({ id: "T-9002", status: "backlog" });
      await store.create(task);

      const unconditionalDone = store.update("T-9002", { status: "done" });
      const conditionalReady = store.update("T-9002", { status: "ready" }, { expected: { status: "backlog" } });

      await unconditionalDone;
      await expect(conditionalReady).rejects.toThrow(StaleWriteError);

      const final = await store.get("T-9002");
      expect(final.status).toBe("done");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

/**
 * T-0384 FIX ROUND 5 (Codex round-2 review 2026-09-19, head 6677455): `requireDependenciesSatisfied`
 * used to run under `_withLock(id)` -- locking only the CANDIDATE's own id. A dependency has a
 * different id and therefore a different lock, so a writer touching that dependency directly
 * (through this same store instance) could still land a status change between the guarded read
 * and the candidate's own write. `update()` now also locks every id in the depends_on list being
 * checked, in one consistent (sorted) order together with the candidate id, so a dependency write
 * through this store cannot interleave with a guarded ready operation that is checking it.
 */
describe("FsTaskStore dependency-aware locking (FIX ROUND 5 interleaving regression)", () => {
  it("blocks a concurrent write to a locked dependency until the guarded update has landed", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-fstaskstore-dep-lock-"));
    try {
      const store = new FsTaskStore(tmpDir);
      await store.create(makeTask({ id: "T-9002", status: "done" }));
      await store.create(makeTask({ id: "T-9001", status: "backlog", depends_on: ["T-9002"] }));

      let releaseDependencyRead;
      const gate = new Promise((resolve) => {
        releaseDependencyRead = resolve;
      });
      const originalReadFile = fs.readFile.bind(fs);
      let dependencyReadSeen = false;
      const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        const isDependencyRead = String(args[0]).endsWith("T-9002.md");
        if (isDependencyRead && !dependencyReadSeen) {
          dependencyReadSeen = true;
          await gate; // pauses T-9001's guarded update right after it reads T-9002 as "done"
        }
        return originalReadFile(...args);
      });

      const guardedReady = store.update(
        "T-9001",
        { status: "ready" },
        { expected: { status: "backlog" }, requireDependenciesSatisfied: true }
      );

      // Give the event loop a tick so guardedReady is paused inside its dependency read.
      await new Promise((resolve) => setTimeout(resolve, 10));

      // A separate write to the DEPENDENCY itself, through the same store instance -- with only
      // the candidate id locked (the pre-fix behaviour), this would land immediately.
      let dependencyWriteSettled = false;
      const dependencyRegression = store
        .update("T-9002", { status: "backlog" })
        .then((result) => {
          dependencyWriteSettled = true;
          return result;
        });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(dependencyWriteSettled).toBe(false);

      releaseDependencyRead();
      const readied = await guardedReady;
      // T-9001's decision was made while T-9002 was genuinely "done" for the entire guarded
      // operation -- the dependency write could not interleave, so the ready transition is valid.
      expect(readied.status).toBe("ready");
      expect(dependencyWriteSettled).toBe(false);

      await dependencyRegression;
      expect(dependencyWriteSettled).toBe(true);
      expect((await store.get("T-9002")).status).toBe("backlog");

      readSpy.mockRestore();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("lets two concurrent guarded writes whose dependency sets overlap in opposite orders both complete without deadlock", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-fstaskstore-dep-lock-order-"));
    try {
      const store = new FsTaskStore(tmpDir);
      await store.create(makeTask({ id: "T-9003", status: "done" }));
      await store.create(makeTask({ id: "T-9004", status: "done" }));
      await store.create(makeTask({ id: "T-9005", status: "backlog", depends_on: ["T-9003", "T-9004"] }));
      await store.create(makeTask({ id: "T-9006", status: "backlog", depends_on: ["T-9004", "T-9003"] }));

      const [r1, r2] = await Promise.all([
        store.update("T-9005", { status: "ready" }, { requireDependenciesSatisfied: true }),
        store.update("T-9006", { status: "ready" }, { requireDependenciesSatisfied: true })
      ]);

      expect(r1.status).toBe("ready");
      expect(r2.status).toBe("ready");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

/**
 * T-0384 FIX ROUND 6 (Chat round-3 review 2026-09-19, P2): FIX ROUND 5 locked the candidate id
 * together with its `depends_on` ids -- but it chose WHICH ids to lock from an unlocked peek taken
 * BEFORE any lock is held. If `depends_on` itself changes between that peek and lock acquisition,
 * the guard ends up holding the WRONG lock set: it locks yesterday's dependency, not today's, and
 * evaluates the real (new) dependency without ever holding its lock. `update()` now re-reads
 * `depends_on` fresh INSIDE the lock it just acquired and compares it against the ids it actually
 * locked; a mismatch releases the lock and retries with the corrected set (bounded), so the guard
 * never evaluates -- or writes against -- a dependency whose lock it doesn't hold.
 */
describe("FsTaskStore dependency-aware locking (FIX ROUND 6 stale-peek regression)", () => {
  it("does not ready a candidate off a lock set chosen from a stale, unlocked peek of depends_on", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-fstaskstore-dep-peek-"));
    try {
      const store = new FsTaskStore(tmpDir);
      await store.create(makeTask({ id: "T-9002", status: "done" }));
      await store.create(makeTask({ id: "T-9003", status: "done" }));
      await store.create(makeTask({ id: "T-9001", status: "backlog", depends_on: ["T-9002"] }));

      const originalReadFile = fs.readFile.bind(fs);
      let t9001ReadCount = 0;
      let t9003ReadCount = 0;
      let releasePeek;
      const peekGate = new Promise((resolve) => {
        releasePeek = resolve;
      });
      let releaseDependencyRead;
      const dependencyReadGate = new Promise((resolve) => {
        releaseDependencyRead = resolve;
      });

      const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        const target = String(args[0]);
        if (target.endsWith("T-9001.md")) {
          t9001ReadCount += 1;
          if (t9001ReadCount === 1) {
            // (1) the guard's own unlocked peek -- read the CURRENT (soon-to-be-stale) bytes now,
            // then hold the result back until after the competing write below has landed, so the
            // guard genuinely decides to lock T-9002 based on what was true a moment ago.
            const stale = await originalReadFile(...args);
            await peekGate;
            return stale;
          }
        }
        if (target.endsWith("T-9003.md")) {
          t9003ReadCount += 1;
          if (t9003ReadCount === 1) {
            // (4) the guard's dependency-status read, taken only once it holds T-9003's lock --
            // hold it back so the competing write below can attempt (and be forced to queue).
            const result = await originalReadFile(...args);
            await dependencyReadGate;
            return result;
          }
        }
        return originalReadFile(...args);
      });

      const guardedReady = store.update("T-9001", { status: "ready" }, { requireDependenciesSatisfied: true });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // (2) a competing write changes T-9001's OWN depends_on to a different, also-done card,
      // while the guard's peek is still holding its stale snapshot back. Nothing locks T-9001 yet
      // -- the peek is unlocked -- so this lands immediately.
      await store.update("T-9001", { depends_on: ["T-9003"] });

      // (3) resume: release the stale peek. The guard locks {T-9001, T-9002} -- the STALE set --
      // and, inside that lock, re-reads T-9001 fresh: depends_on is now ["T-9003"], a mismatch
      // against the locked set. It must retry rather than evaluate T-9002 (no longer real) or
      // T-9003 (real, but unlocked).
      releasePeek();

      await new Promise((resolve) => setTimeout(resolve, 10));

      // (4) once the guard has re-locked onto the CORRECT set and reached its dependency read for
      // T-9003, try to move T-9003 to backlog through the same store.
      let dependencyWriteSettled = false;
      const dependencyRegression = store.update("T-9003", { status: "backlog" }).then((result) => {
        dependencyWriteSettled = true;
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      // Because the guard's corrected lock set now includes T-9003, this competing write cannot
      // land while the guard is still mid-check -- it queues behind the lock instead of racing it.
      expect(dependencyWriteSettled).toBe(false);

      // (5) resume
      releaseDependencyRead();
      const readied = await guardedReady;

      // The outcome is never "T-9001 ready while T-9003 is backlog" -- the write queued behind
      // the guard's own lock on T-9003, so it can only land after the guard's decision, and the
      // guard's decision was made while genuinely holding T-9003's lock.
      expect(readied.status).toBe("ready");
      expect(dependencyWriteSettled).toBe(false);

      await dependencyRegression;
      expect(dependencyWriteSettled).toBe(true);
      expect((await store.get("T-9003")).status).toBe("backlog");
      expect((await store.get("T-9001")).depends_on).toEqual(["T-9003"]);

      readSpy.mockRestore();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses with DependencyLockSetUnstableError after a bounded number of attempts, instead of retrying forever", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-fstaskstore-dep-unstable-"));
    try {
      const store = new FsTaskStore(tmpDir);
      await store.create(makeTask({ id: "T-9008", status: "done" }));
      await store.create(makeTask({ id: "T-9009", status: "done" }));
      await store.create(makeTask({ id: "T-9007", status: "backlog", depends_on: ["T-9008"] }));

      const originalGet = store.get.bind(store);
      let calls = 0;
      const getSpy = vi.spyOn(store, "get").mockImplementation(async (id) => {
        if (id !== "T-9007") return originalGet(id);
        calls += 1;
        const task = await originalGet(id);
        if (!task) return task;
        // Every single read of T-9007 -- both the unlocked peek and the fresh re-read inside the
        // lock -- reports a DIFFERENT depends_on than the one before it, so the guard's lock set
        // can never match what it reads once it holds it. It must give up, not spin forever.
        const depends_on = calls % 2 === 0 ? ["T-9008"] : ["T-9009"];
        return { ...task, depends_on };
      });

      await expect(
        store.update("T-9007", { status: "ready" }, { requireDependenciesSatisfied: true })
      ).rejects.toThrow(DependencyLockSetUnstableError);

      expect((await store.get("T-9007")).status).toBe("backlog");
      getSpy.mockRestore();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("lets two concurrent guarded writes whose dependency sets change mid-flight both resolve without deadlocking", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-fstaskstore-dep-unstable-order-"));
    try {
      const store = new FsTaskStore(tmpDir);
      await store.create(makeTask({ id: "T-9040", status: "done" }));
      await store.create(makeTask({ id: "T-9041", status: "done" }));
      await store.create(makeTask({ id: "T-9042", status: "backlog", depends_on: ["T-9040"] }));
      await store.create(makeTask({ id: "T-9043", status: "backlog", depends_on: ["T-9041"] }));

      const originalGet = store.get.bind(store);
      let seen42 = 0;
      let seen43 = 0;
      const getSpy = vi.spyOn(store, "get").mockImplementation(async (id) => {
        if (id === "T-9042") {
          seen42 += 1;
          const task = await originalGet(id);
          if (!task) return task;
          // The very first read (the initial unlocked peek) reports the OTHER candidate's
          // dependency -- forcing one retry cycle, with the two candidates' lock sets crossing
          // over each other -- before stabilizing on the real value for every read after.
          return { ...task, depends_on: seen42 === 1 ? ["T-9041"] : ["T-9040"] };
        }
        if (id === "T-9043") {
          seen43 += 1;
          const task = await originalGet(id);
          if (!task) return task;
          return { ...task, depends_on: seen43 === 1 ? ["T-9040"] : ["T-9041"] };
        }
        return originalGet(id);
      });

      const [r1, r2] = await Promise.all([
        store.update("T-9042", { status: "ready" }, { requireDependenciesSatisfied: true }),
        store.update("T-9043", { status: "ready" }, { requireDependenciesSatisfied: true })
      ]);

      expect(r1.status).toBe("ready");
      expect(r2.status).toBe("ready");
      getSpy.mockRestore();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
