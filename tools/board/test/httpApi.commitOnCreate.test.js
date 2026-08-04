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
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-commit-"));
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

describe("POST /api/tasks — commits the card file to git", () => {
  it("commits the new card file so it's tracked, not left untracked", async () => {
    const task = await createTask();

    const { stdout: status } = await git(["status", "--porcelain", "--", `tasks/${task.id}.md`], repoRoot);
    expect(status.trim()).toBe("");
    const { stdout: lsFiles } = await git(["ls-files", `tasks/${task.id}.md`], repoRoot);
    expect(lsFiles.trim()).toBe(`tasks/${task.id}.md`);
  });

  it("uses a descriptive commit message referencing the card id", async () => {
    const task = await createTask({ title: "Ship the thing" });

    const { stdout: log } = await git(["log", "-1", "--pretty=%s"], repoRoot);
    expect(log.trim()).toContain(task.id);
  });

  it("commits each card as its own commit, not batched together", async () => {
    const first = await createTask({ title: "First" });
    const second = await createTask({ title: "Second" });

    const { stdout: log } = await git(["log", "--oneline"], repoRoot);
    const lines = log.trim().split("\n");
    // initial + one commit per card
    expect(lines.length).toBe(3);
    expect(log).toContain(first.id);
    expect(log).toContain(second.id);
  });

  it("does not commit when AUTO_COMMIT_CARDS_ON_CREATE is disabled", async () => {
    process.env.AUTO_COMMIT_CARDS_ON_CREATE = "false";
    const task = await createTask();

    const { stdout: status } = await git(["status", "--porcelain", "--", `tasks/${task.id}.md`], repoRoot);
    expect(status.trim()).toBe(`?? tasks/${task.id}.md`);
    const { stdout: lsFiles } = await git(["ls-files", `tasks/${task.id}.md`], repoRoot);
    expect(lsFiles.trim()).toBe("");
  });

  it("still returns 201 with the created card even if committing fails", async () => {
    // Corrupt the repo's git dir so the commit step fails, without touching FS writes.
    await fs.rename(path.join(repoRoot, ".git"), path.join(repoRoot, ".git.disabled"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Survives git failure", phase: 1 })
    });

    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.title).toBe("Survives git failure");
    const onDisk = await fs.readFile(path.join(tasksDir, `${task.id}.md`), "utf8");
    expect(onDisk).toContain("Survives git failure");
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    await fs.rename(path.join(repoRoot, ".git.disabled"), path.join(repoRoot, ".git"));
  });

  it("does not attempt a commit when no repoRoot is configured on the server", async () => {
    const bareDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-nocommit-"));
    const bareStore = new FsTaskStore(bareDir);
    const bareAllocator = new IdAllocator(bareDir);
    const bareServer = await startHttpServer({ store: bareStore, idAllocator: bareAllocator, port: 0 });
    const { port } = bareServer.address();

    const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No repo configured", phase: 1 })
    });

    expect(res.status).toBe(201);
    await new Promise((resolve) => bareServer.close(resolve));
    await fs.rm(bareDir, { recursive: true, force: true });
  });
});
