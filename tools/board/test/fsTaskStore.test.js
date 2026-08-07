import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/lib/taskStore.js";
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
