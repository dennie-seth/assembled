import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";

vi.mock("../src/runner/gitOps.js", () => ({
  pullDevelop: vi.fn().mockResolvedValue({ advanced: false, before: "aaa", after: "aaa" })
}));

import { pullDevelop } from "../src/runner/gitOps.js";

function makeRestartCoordinator() {
  return { notifyPulled: vi.fn(), notifyIdle: vi.fn() };
}

function makeOrchestrator(hasActiveRuns) {
  return { hasActiveRuns: vi.fn(() => hasActiveRuns) };
}

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

describe("PATCH /api/tasks/:id — done triggers restart-on-pull coordination", () => {
  it("notifies the restart coordinator with hasActiveRuns: false when the pull advances code and no run is active", async () => {
    pullDevelop.mockResolvedValueOnce({ advanced: true, before: "aaa", after: "bbb" });
    const restartCoordinator = makeRestartCoordinator();
    const orchestrator = makeOrchestrator(false);
    const withOrchestrator = await startHttpServer({
      store: new FsTaskStore(tmpDir),
      idAllocator: new IdAllocator(tmpDir),
      port: 0,
      repoRoot: "/fake/repo",
      orchestrator,
      restartCoordinator
    });
    const { port } = withOrchestrator.address();
    const url = `http://127.0.0.1:${port}`;

    const createRes = await fetch(`${url}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Restart test", phase: 1 })
    });
    const task = await createRes.json();

    await fetch(`${url}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" })
    });

    await vi.waitFor(() => expect(restartCoordinator.notifyPulled).toHaveBeenCalledWith({ hasActiveRuns: false }));

    await new Promise((resolve) => withOrchestrator.close(resolve));
  });

  it("notifies the restart coordinator with hasActiveRuns: true when a card run is active — restart must be deferred", async () => {
    pullDevelop.mockResolvedValueOnce({ advanced: true, before: "aaa", after: "bbb" });
    const restartCoordinator = makeRestartCoordinator();
    const orchestrator = makeOrchestrator(true);
    const withOrchestrator = await startHttpServer({
      store: new FsTaskStore(tmpDir),
      idAllocator: new IdAllocator(tmpDir),
      port: 0,
      repoRoot: "/fake/repo",
      orchestrator,
      restartCoordinator
    });
    const { port } = withOrchestrator.address();
    const url = `http://127.0.0.1:${port}`;

    const createRes = await fetch(`${url}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Restart deferred test", phase: 1 })
    });
    const task = await createRes.json();

    await fetch(`${url}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" })
    });

    await vi.waitFor(() => expect(restartCoordinator.notifyPulled).toHaveBeenCalledWith({ hasActiveRuns: true }));

    await new Promise((resolve) => withOrchestrator.close(resolve));
  });

  it("does not notify the restart coordinator when the pull was a no-op (HEAD did not advance)", async () => {
    pullDevelop.mockResolvedValueOnce({ advanced: false, before: "aaa", after: "aaa" });
    const restartCoordinator = makeRestartCoordinator();
    const orchestrator = makeOrchestrator(false);
    const withOrchestrator = await startHttpServer({
      store: new FsTaskStore(tmpDir),
      idAllocator: new IdAllocator(tmpDir),
      port: 0,
      repoRoot: "/fake/repo",
      orchestrator,
      restartCoordinator
    });
    const { port } = withOrchestrator.address();
    const url = `http://127.0.0.1:${port}`;

    const createRes = await fetch(`${url}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No-op pull test", phase: 1 })
    });
    const task = await createRes.json();

    await fetch(`${url}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" })
    });

    await vi.waitFor(() => expect(pullDevelop).toHaveBeenCalled());
    await new Promise((r) => setImmediate(r));
    expect(restartCoordinator.notifyPulled).not.toHaveBeenCalled();

    await new Promise((resolve) => withOrchestrator.close(resolve));
  });

  it("does not throw when the pull advances code but no restartCoordinator was configured on the server", async () => {
    pullDevelop.mockResolvedValueOnce({ advanced: true, before: "aaa", after: "bbb" });
    const noCoordinatorServer = await startHttpServer({
      store: new FsTaskStore(tmpDir),
      idAllocator: new IdAllocator(tmpDir),
      port: 0,
      repoRoot: "/fake/repo"
    });
    const { port } = noCoordinatorServer.address();
    const url = `http://127.0.0.1:${port}`;

    const createRes = await fetch(`${url}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No coordinator test", phase: 1 })
    });
    const task = await createRes.json();

    const res = await fetch(`${url}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" })
    });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(pullDevelop).toHaveBeenCalled());

    await new Promise((resolve) => noCoordinatorServer.close(resolve));
  });
});
