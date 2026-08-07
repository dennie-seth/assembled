import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { DbTaskStore } from "../src/lib/db/dbTaskStore.js";
import { IdAllocatorDb } from "../src/lib/db/idAllocatorDb.js";
import { startHttpServer } from "../src/server/httpApi.js";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

// A real, valid 1x1 transparent PNG (magic bytes matter -- the endpoint sniffs content, not extension).
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

let repoRoot;
let tasksDir;
let dataDir;
let store;
let hub;
let server;
let baseUrl;

beforeEach(async () => {
  // A real git repo with tasks/ tracked -- the Phase 2 dual-track window: db mode is live, but
  // tasks/ still has real fs-mode content checked out from develop until Phase 3 removes it.
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-dbmode-"));
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "test@example.com"], repoRoot);
  await git(["config", "user.name", "Test"], repoRoot);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"], repoRoot);
  await git(["commit", "-m", "initial"], repoRoot);

  tasksDir = path.join(repoRoot, "tasks");
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-dbmode-data-"));
  store = new DbTaskStore(":memory:");
  const idAllocator = new IdAllocatorDb(store.db);
  hub = { broadcast: vi.fn() };

  server = await startHttpServer({
    store,
    idAllocator,
    repoRoot,
    tasksDir,
    dataDir,
    taskStoreKind: "db",
    hub,
    port: 0
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  delete process.env.AUTO_COMMIT_CARDS_ON_CREATE;
  await new Promise((resolve) => server.close(resolve));
  store.close();
  await fs.rm(repoRoot, { recursive: true, force: true });
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function createTask(overrides = {}) {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Test task", phase: 1, ...overrides })
  });
  return res.json();
}

async function gitLogCount() {
  const { stdout } = await git(["log", "--oneline"], repoRoot);
  return stdout.trim().split("\n").filter(Boolean).length;
}

describe("db mode -- POST /api/tasks", () => {
  it("creates the task in the DB and never touches git", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Db card", phase: 1 })
    });
    expect(res.status).toBe(201);
    const task = await res.json();

    expect(await store.get(task.id)).toMatchObject({ title: "Db card" });
    expect(await gitLogCount()).toBe(1);
    const { stdout: status } = await git(["status", "--porcelain"], repoRoot);
    expect(status.trim()).toBe("");
  });

  it("broadcasts an 'added' event directly over hub", async () => {
    const task = await createTask({ title: "Broadcast me" });
    expect(hub.broadcast).toHaveBeenCalledWith({ type: "added", id: task.id, task: expect.objectContaining({ title: "Broadcast me" }) });
  });
});

describe("db mode -- PATCH /api/tasks/:id", () => {
  it("updates the task in the DB and never touches git", async () => {
    const task = await createTask();
    hub.broadcast.mockClear();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready" })
    });
    expect(res.status).toBe(200);

    expect(await store.get(task.id)).toMatchObject({ status: "ready" });
    expect(await gitLogCount()).toBe(1);
    expect(hub.broadcast).toHaveBeenCalledWith({ type: "changed", id: task.id, task: expect.objectContaining({ status: "ready" }) });
  });

  it("does not call pullDevelop when a card moves to done -- meaningless once card writes never touch git", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" })
    });
    expect(res.status).toBe(200);

    await new Promise((resolve) => setImmediate(resolve));
    expect(await gitLogCount()).toBe(1);
    const { stdout: status } = await git(["status", "--porcelain"], repoRoot);
    expect(status.trim()).toBe("");
  });
});

describe("db mode -- POST /api/tasks/:id/comments", () => {
  it("updates the DB, broadcasts, and never touches git", async () => {
    const task = await createTask();
    hub.broadcast.mockClear();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "please fix X", author: "Dennie" })
    });
    expect(res.status).toBe(201);

    const updated = await store.get(task.id);
    expect(updated.comments).toHaveLength(1);
    expect(await gitLogCount()).toBe(1);
    expect(hub.broadcast).toHaveBeenCalledWith({ type: "changed", id: task.id, task: expect.objectContaining({ comments: updated.comments }) });
  });
});

describe("db mode -- attachments live under dataDir, not tasksDir", () => {
  function pngUploadForm() {
    const form = new FormData();
    form.append("file", new Blob([TINY_PNG], { type: "image/png" }), "reference.png");
    return form;
  }

  it("uploads to <dataDir>/attachments/<id>/, not <tasksDir>/attachments/<id>/", async () => {
    const task = await createTask();
    hub.broadcast.mockClear();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: pngUploadForm() });
    expect(res.status).toBe(201);

    const onDisk = await fs.readFile(path.join(dataDir, "attachments", task.id, "reference.png"));
    expect(onDisk.equals(TINY_PNG)).toBe(true);
    await expect(fs.stat(path.join(tasksDir, "attachments", task.id, "reference.png"))).rejects.toThrow();
    expect(await gitLogCount()).toBe(1);
    expect(hub.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "changed", id: task.id }));
  });

  it("downloads from <dataDir>/attachments/<id>/", async () => {
    const task = await createTask();
    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: pngUploadForm() });

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments/reference.png`);
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(TINY_PNG)).toBe(true);
  });

  it("removes from <dataDir>/attachments/<id>/, broadcasts, and never touches git", async () => {
    const task = await createTask();
    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: pngUploadForm() });
    hub.broadcast.mockClear();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/attachments/reference.png`, { method: "DELETE" });
    expect(res.status).toBe(200);

    await expect(fs.stat(path.join(dataDir, "attachments", task.id, "reference.png"))).rejects.toThrow();
    expect(await gitLogCount()).toBe(1);
    expect(hub.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "changed", id: task.id }));
  });
});

describe("db mode -- DELETE /api/tasks/:id", () => {
  it("removes from the DB and broadcasts a 'removed' event", async () => {
    const task = await createTask();
    hub.broadcast.mockClear();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    expect(await store.get(task.id)).toBeNull();
    expect(hub.broadcast).toHaveBeenCalledWith({ type: "removed", id: task.id, task: null });
  });

  it("also removes the card's attachment directory from <dataDir>/attachments/<id>/ (T-0150)", async () => {
    const task = await createTask();
    const form = new FormData();
    form.append("file", new Blob([TINY_PNG], { type: "image/png" }), "reference.png");
    await fetch(`${baseUrl}/api/tasks/${task.id}/attachments`, { method: "POST", body: form });
    const cardAttachmentsDir = path.join(dataDir, "attachments", task.id);
    await expect(fs.stat(cardAttachmentsDir)).resolves.toBeTruthy();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    await expect(fs.stat(cardAttachmentsDir)).rejects.toThrow();
  });

  it("deleting a card with no attachments is a no-op on disk, not an error", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "DELETE" });

    expect(res.status).toBe(200);
  });

  it("does not delete another card's attachment directory when the deleted id is a prefix of it", async () => {
    const task = await createTask();
    const otherId = `${task.id}-evil`;
    await fs.mkdir(path.join(dataDir, "attachments", otherId), { recursive: true });
    await fs.writeFile(path.join(dataDir, "attachments", otherId, "keep.txt"), "keep me");

    await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "DELETE" });

    await expect(
      fs.readFile(path.join(dataDir, "attachments", otherId, "keep.txt"), "utf8")
    ).resolves.toBe("keep me");
  });
});

describe("db mode -- fs-mode behavior stays available side-by-side (taskStoreKind default)", () => {
  it("defaults createRequestListener/startHttpServer to fs mode when taskStoreKind is omitted", async () => {
    // Regression guard for the stability constraint: omitting taskStoreKind must behave exactly
    // like fs mode (the code default), not silently skip commits.
    const { FsTaskStore } = await import("../src/lib/fsTaskStore.js");
    const { IdAllocator } = await import("../src/lib/idAllocator.js");
    const fsTasksDir = path.join(repoRoot, "tasks");
    const fsStore = new FsTaskStore(fsTasksDir);
    const fsIdAllocator = new IdAllocator(fsTasksDir);
    const fsServer = await startHttpServer({ store: fsStore, idAllocator: fsIdAllocator, repoRoot, tasksDir: fsTasksDir, port: 0 });
    const { port } = fsServer.address();

    const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "fs default card", phase: 1 })
    });
    const task = await res.json();

    const { stdout: lsFiles } = await git(["ls-files", `tasks/${task.id}.md`], repoRoot);
    expect(lsFiles.trim()).toBe(`tasks/${task.id}.md`);

    await new Promise((resolve) => fsServer.close(resolve));
  });
});
