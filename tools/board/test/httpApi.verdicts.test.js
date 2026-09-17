import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmTemp } from "./helpers/rmTemp.js";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";
import { appendVerdictEntry } from "../src/lib/verdictArchive.js";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

let repoRoot;
let tasksDir;
let server;
let baseUrl;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-verdicts-"));
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
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rmTemp(repoRoot);
});

async function createTask(overrides = {}) {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Test task", phase: 1, ...overrides })
  });
  return res.json();
}

describe("GET /api/tasks/:id/verdicts", () => {
  it("returns an empty entries array for a card with nothing archived yet", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/verdicts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ entries: [] });
  });

  it("returns a card's archived verdict entries, oldest first, so a human can still read the reviewer's history", async () => {
    const task = await createTask();
    await appendVerdictEntry(tasksDir, task.id, {
      heading: "Validation: FAIL",
      timestamp: "2026-09-01T00:00:00.000Z",
      text: "missing test coverage"
    });
    await appendVerdictEntry(tasksDir, task.id, {
      heading: "Validation: PASS",
      timestamp: "2026-09-02T00:00:00.000Z",
      text: "fixed, all green"
    });

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/verdicts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toEqual([
      { heading: "Validation: FAIL", timestamp: "2026-09-01T00:00:00.000Z", text: "missing test coverage" },
      { heading: "Validation: PASS", timestamp: "2026-09-02T00:00:00.000Z", text: "fixed, all green" }
    ]);
  });

  it("404s for a task id that doesn't exist", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/T-9999/verdicts`);
    expect(res.status).toBe(404);
  });
});
