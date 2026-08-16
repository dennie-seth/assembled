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
    // chokidar can emit both 'add' and 'change' for a single writeFile on some
    // file systems (Linux/WSL2 in particular). Drain any extra queued events
    // before arming the listener for the 'unlink' so the delete event isn't
    // preempted by a stale 'changed' event from the write.
    await new Promise((resolve) => setTimeout(resolve, 100));

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

  it("survives an external edit that leaves a task file unparseable, with no 'error' listener attached", async () => {
    // Deliberately no watcher.on("error", ...) here -- a consumer that never
    // registers one (like this test, until now) must not crash the process.
    // EventEmitter throws synchronously on an emitted 'error' with no
    // listener, which turns into an unhandled rejection from inside
    // _handleUpsert's async call. See fix(board): stabilize TaskWatcher
    // against mid-write chokidar events (4e606d0) for the same failure mode.
    await fs.writeFile(path.join(tmpDir, "T-0001.md"), "not a task file\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The watcher must still be alive and working afterward.
    const eventPromise = waitForEvent(watcher, "task-changed");
    await fs.writeFile(path.join(tmpDir, "T-0002.md"), makeTaskRaw({ id: "T-0002" }), "utf8");
    const event = await eventPromise;
    expect(event.type).toBe("added");
    expect(event.id).toBe("T-0002");
  });

  it("emits 'error' (instead of throwing) when a listener is registered and a file fails to parse", async () => {
    const errors = [];
    watcher.on("error", (err) => errors.push(err));

    await fs.writeFile(path.join(tmpDir, "T-0001.md"), "not a task file\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/missing frontmatter delimiters/);
  });
});
