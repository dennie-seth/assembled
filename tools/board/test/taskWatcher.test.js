import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskWatcher } from "../src/lib/taskWatcher.js";
import { serializeTask } from "../src/lib/taskParser.js";

let tmpDir;
let watcher;

function makeTaskRaw(overrides = {}) {
  return serializeTask({
    id: "T-0001",
    title: "Watched task",
    status: "backlog",
    priority: "P1",
    phase: 1,
    agent: "infra",
    depends_on: [],
    created: "2026-07-31",
    body: "## Context\n...\n",
    ...overrides
  });
}

function waitForEvent(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-taskwatcher-"));
  watcher = new TaskWatcher(tmpDir);
  await watcher.start();
});

afterEach(async () => {
  await watcher.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("TaskWatcher", () => {
  it("emits task-changed with type 'added' when a task file is created externally", async () => {
    const eventPromise = waitForEvent(watcher, "task-changed");
    await fs.writeFile(path.join(tmpDir, "T-0001.md"), makeTaskRaw(), "utf8");

    const event = await eventPromise;
    expect(event.type).toBe("added");
    expect(event.id).toBe("T-0001");
    expect(event.task.title).toBe("Watched task");
  });

  it("emits task-changed with type 'changed' when a task file is edited externally", async () => {
    await fs.writeFile(path.join(tmpDir, "T-0001.md"), makeTaskRaw(), "utf8");
    await waitForEvent(watcher, "task-changed");

    const eventPromise = waitForEvent(watcher, "task-changed");
    await fs.writeFile(path.join(tmpDir, "T-0001.md"), makeTaskRaw({ title: "Edited" }), "utf8");

    const event = await eventPromise;
    expect(event.type).toBe("changed");
    expect(event.task.title).toBe("Edited");
  });

  it("emits task-changed with type 'removed' when a task file is deleted externally", async () => {
    await fs.writeFile(path.join(tmpDir, "T-0001.md"), makeTaskRaw(), "utf8");
    await waitForEvent(watcher, "task-changed");

    const eventPromise = waitForEvent(watcher, "task-changed");
    await fs.rm(path.join(tmpDir, "T-0001.md"));

    const event = await eventPromise;
    expect(event.type).toBe("removed");
    expect(event.id).toBe("T-0001");
    expect(event.task).toBeNull();
  });

  it("ignores non-.md files", async () => {
    let sawEvent = false;
    watcher.on("task-changed", () => {
      sawEvent = true;
    });
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "hello", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sawEvent).toBe(false);
  });
});
