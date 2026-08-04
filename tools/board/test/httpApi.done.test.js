import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";

vi.mock("../src/runner/gitOps.js", () => ({
  pullDevelop: vi.fn().mockResolvedValue(undefined)
}));

import { pullDevelop } from "../src/runner/gitOps.js";

let tmpDir;
let server;
let baseUrl;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpdone-"));
  const store = new FsTaskStore(tmpDir);
  const idAllocator = new IdAllocator(tmpDir);
  server = await startHttpServer({ store, idAllocator, port: 0, repoRoot: "/fake/repo" });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function createTask(overrides = {}) {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Test task", phase: 1, ...overrides })
  });
  return res.json();
}

describe("PATCH /api/tasks/:id — done triggers dev branch pull", () => {
  it("calls pullDevelop with the configured repoRoot when status is patched to done", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" })
    });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(pullDevelop).toHaveBeenCalledWith({ repoRoot: "/fake/repo" }));
  });

  it("does not call pullDevelop when status is patched to a non-done value", async () => {
    const task = await createTask();

    await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready" })
    });

    // Give async fire-and-forget a tick to potentially misbehave
    await new Promise((r) => setImmediate(r));
    expect(pullDevelop).not.toHaveBeenCalled();
  });

  it("still returns 200 even when pullDevelop rejects", async () => {
    pullDevelop.mockRejectedValueOnce(new Error("network down"));
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" })
    });

    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.status).toBe("done");
  });

  it("does not call pullDevelop when no repoRoot is configured on the server", async () => {
    const bareStore = new FsTaskStore(tmpDir);
    const bareAllocator = new IdAllocator(tmpDir);
    const bareServer = await startHttpServer({ store: bareStore, idAllocator: bareAllocator, port: 0 });
    const { port } = bareServer.address();
    const bareUrl = `http://127.0.0.1:${port}`;

    const createRes = await fetch(`${bareUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No pull task", phase: 1 })
    });
    const bareTask = await createRes.json();

    const res = await fetch(`${bareUrl}/api/tasks/${bareTask.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" })
    });

    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(pullDevelop).not.toHaveBeenCalled();

    await new Promise((resolve) => bareServer.close(resolve));
  });
});
