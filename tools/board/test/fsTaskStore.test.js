import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/lib/taskStore.js";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";

let tmpDir;
let store;

function makeTask(overrides = {}) {
  return {
    id: "T-0001",
    title: "Example task",
    status: "backlog",
    priority: "P1",
    phase: 1,
    agent: "infra",
    depends_on: [],
    created: "2026-07-31",
    branch: null,
    commit: null,
    pr: null,
    deliverable_type: "code",
    attempts: 0,
    comments: [],
    attachments: [],
    body: "## Context\n...\n## Acceptance\n- [ ] ...\n",
    ...overrides
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-fstaskstore-"));
  store = new FsTaskStore(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

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

  it("FsTaskStore is a TaskStore", () => {
    expect(store).toBeInstanceOf(TaskStore);
  });
});

describe("FsTaskStore CRUD", () => {
  it("creates a task and reads it back", async () => {
    const task = makeTask();
    await store.create(task);
    expect(await store.get(task.id)).toEqual(task);
  });

  it("get returns null for a missing id", async () => {
    expect(await store.get("T-9999")).toBeNull();
  });

  it("list returns all tasks sorted by id", async () => {
    await store.create(makeTask({ id: "T-0003" }));
    await store.create(makeTask({ id: "T-0001" }));
    await store.create(makeTask({ id: "T-0002" }));
    const ids = (await store.list()).map((t) => t.id);
    expect(ids).toEqual(["T-0001", "T-0002", "T-0003"]);
  });

  it("update merges partial fields and persists them", async () => {
    const task = makeTask();
    await store.create(task);
    const updated = await store.update(task.id, { status: "ready", title: "Renamed" });
    expect(updated).toMatchObject({
      id: task.id,
      status: "ready",
      title: "Renamed",
      priority: task.priority
    });
    expect(await store.get(task.id)).toEqual(updated);
  });

  it("update throws for a task that does not exist", async () => {
    await expect(store.update("T-9999", { status: "ready" })).rejects.toThrow(/not found/i);
  });

  it("update rejects attempts to change the task id", async () => {
    const task = makeTask();
    await store.create(task);
    await expect(store.update(task.id, { id: "T-9999" })).rejects.toThrow(/id/i);
  });

  it("move updates only the status field", async () => {
    const task = makeTask();
    await store.create(task);
    const moved = await store.move(task.id, "in-progress");
    expect(moved).toEqual({ ...task, status: "in-progress" });
  });
});

describe("FsTaskStore comments", () => {
  it("persists an appended comment and reads it back", async () => {
    const task = makeTask();
    await store.create(task);
    const comment = { author: "Dennie", text: "please fix the CI failure", timestamp: "2026-08-05T12:00:00.000Z" };
    const updated = await store.update(task.id, { comments: [comment] });
    expect(updated.comments).toEqual([comment]);
    expect(await store.get(task.id)).toEqual(updated);
  });

  it("survives an unrelated update -- a status/body write never clobbers existing comments", async () => {
    const task = makeTask();
    await store.create(task);
    const comment = { author: "Dennie", text: "fix X", timestamp: "2026-08-05T12:00:00.000Z" };
    await store.update(task.id, { comments: [comment] });

    const updated = await store.update(task.id, { status: "in-progress", body: "## Notes\nre-run" });

    expect(updated.comments).toEqual([comment]);
    expect(await store.get(task.id)).toMatchObject({ comments: [comment], status: "in-progress" });
  });
});

describe("FsTaskStore attachments", () => {
  it("persists an appended attachment and reads it back", async () => {
    const task = makeTask();
    await store.create(task);
    const attachment = {
      filename: "reference.png",
      size: 1024,
      mimetype: "image/png",
      uploaded_by: "Dennie",
      uploaded_at: "2026-08-05T12:00:00.000Z"
    };
    const updated = await store.update(task.id, { attachments: [attachment] });
    expect(updated.attachments).toEqual([attachment]);
    expect(await store.get(task.id)).toEqual(updated);
  });

  it("survives an unrelated update -- a status/body write never clobbers existing attachments", async () => {
    const task = makeTask();
    await store.create(task);
    const attachment = {
      filename: "reference.png",
      size: 1024,
      mimetype: "image/png",
      uploaded_by: "Dennie",
      uploaded_at: "2026-08-05T12:00:00.000Z"
    };
    await store.update(task.id, { attachments: [attachment] });

    const updated = await store.update(task.id, { status: "in-progress", body: "## Notes\nre-run" });

    expect(updated.attachments).toEqual([attachment]);
    expect(await store.get(task.id)).toMatchObject({ attachments: [attachment], status: "in-progress" });
  });
});

describe("FsTaskStore remove", () => {
  it("deletes the task's file", async () => {
    const task = makeTask();
    await store.create(task);
    await store.remove(task.id);
    expect(await store.get(task.id)).toBeNull();
    expect(await fs.readdir(tmpDir)).not.toContain(`${task.id}.md`);
  });

  it("throws when removing a task that does not exist", async () => {
    await expect(store.remove("T-9999")).rejects.toThrow(/not found/i);
  });
});

describe("FsTaskStore id collisions", () => {
  it("rejects creating a task whose id already exists", async () => {
    await store.create(makeTask({ id: "T-0001" }));
    await expect(store.create(makeTask({ id: "T-0001", title: "Different" }))).rejects.toThrow(
      /already exists/i
    );
  });

  it("leaves the original file untouched after a rejected collision", async () => {
    const original = makeTask({ id: "T-0001" });
    await store.create(original);
    await expect(store.create(makeTask({ id: "T-0001", title: "Different" }))).rejects.toThrow();
    expect(await store.get("T-0001")).toEqual(original);
  });
});

describe("FsTaskStore atomic writes", () => {
  it("leaves no stray temp files in the tasks dir after create/update/move", async () => {
    const task = makeTask();
    await store.create(task);
    await store.update(task.id, { status: "ready" });
    await store.move(task.id, "in-progress");
    const entries = await fs.readdir(tmpDir);
    expect(entries).toEqual(["T-0001.md"]);
  });
});
