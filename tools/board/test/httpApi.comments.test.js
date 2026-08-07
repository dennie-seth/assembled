import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

let repoRoot;
let tasksDir;
let server;
let baseUrl;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-comments-"));
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "test@example.com"], repoRoot);
  await git(["config", "user.name", "Test"], repoRoot);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"], repoRoot);
  await git(["commit", "-m", "initial"], repoRoot);

  tasksDir = path.join(repoRoot, "tasks");
  const store = new FsTaskStore(tasksDir);
  const idAllocator = new IdAllocator(tasksDir);
  server = await startHttpServer({ store, idAllocator, repoRoot, tasksDir, port: 0 });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  delete process.env.AUTO_COMMIT_CARDS_ON_CREATE;
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(repoRoot, { recursive: true, force: true });
});

async function createTask(overrides = {}) {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Test task", phase: 1, ...overrides })
  });
  return res.json();
}

describe("POST /api/tasks/:id/comments", () => {
  it("appends a comment and returns the updated task", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: "Dennie", text: "CI failed on lint, please fix." })
    });

    expect(res.status).toBe(201);
    const updated = await res.json();
    expect(updated.comments).toHaveLength(1);
    expect(updated.comments[0]).toMatchObject({ author: "Dennie", text: "CI failed on lint, please fix." });
    expect(typeof updated.comments[0].timestamp).toBe("string");
  });

  it("appends to existing comments rather than replacing them", async () => {
    const task = await createTask();
    await fetch(`${baseUrl}/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: "Dennie", text: "first" })
    });

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: "Dennie", text: "second" })
    });

    const updated = await res.json();
    expect(updated.comments.map((c) => c.text)).toEqual(["first", "second"]);
  });

  it("defaults the author to Anonymous when not provided", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "no author given" })
    });

    const updated = await res.json();
    expect(updated.comments[0].author).toBe("Anonymous");
  });

  it("returns 400 when text is missing or empty", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: "Dennie", text: "  " })
    });

    expect(res.status).toBe(400);
  });

  it("returns 404 for a task that does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/T-9999/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" })
    });

    expect(res.status).toBe(404);
  });

  it("survives (is not clobbered by) a later unrelated PATCH to the card", async () => {
    const task = await createTask();
    await fetch(`${baseUrl}/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: "Dennie", text: "please fix X" })
    });

    await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready" })
    });

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`);
    const current = await res.json();
    expect(current.comments).toHaveLength(1);
    expect(current.comments[0].text).toBe("please fix X");
  });

  it("commits the comment to git so it's tracked, not left untracked", async () => {
    const task = await createTask();

    await fetch(`${baseUrl}/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: "Dennie", text: "please fix X" })
    });

    const { stdout: status } = await git(["status", "--porcelain", "--", `tasks/${task.id}.md`], repoRoot);
    expect(status.trim()).toBe("");
    const { stdout: log } = await git(["log", "-1", "--pretty=%s"], repoRoot);
    expect(log.trim()).toContain(task.id);
  });

  it("does not commit when AUTO_COMMIT_CARDS_ON_CREATE is disabled", async () => {
    const task = await createTask();
    process.env.AUTO_COMMIT_CARDS_ON_CREATE = "false";

    await fetch(`${baseUrl}/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: "Dennie", text: "please fix X" })
    });

    const { stdout: status } = await git(["status", "--porcelain", "--", `tasks/${task.id}.md`], repoRoot);
    expect(status.trim()).toBe(`M tasks/${task.id}.md`);
  });

  it("still returns 201 with the updated task even if committing fails", async () => {
    const task = await createTask();
    await fs.rename(path.join(repoRoot, ".git"), path.join(repoRoot, ".git.disabled"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: "Dennie", text: "please fix X" })
    });

    expect(res.status).toBe(201);
    const updated = await res.json();
    expect(updated.comments[0].text).toBe("please fix X");
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    await fs.rename(path.join(repoRoot, ".git.disabled"), path.join(repoRoot, ".git"));
  });

  it("returns 405 for GET on the comments endpoint", async () => {
    const task = await createTask();
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/comments`, { method: "GET" });
    expect(res.status).toBe(405);
  });
});
