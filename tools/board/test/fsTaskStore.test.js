import { describe, it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore, StaleWriteError } from "../src/lib/taskStore.js";
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
