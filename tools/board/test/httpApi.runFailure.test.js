import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";

/**
 * Tests for T-0165: run failures that occur after the 202 is sent must be
 * captured and surfaced on the card rather than dying silently in the log.
 *
 * The fire-and-forget path in handleRunTask (httpApi.js) is the caller under test.
 */
describe("POST /api/tasks/:id/run — async failure surfacing", () => {
  let tmpDir;
  let server;
  let baseUrl;
  let orchestrator;
  let broadcastCalls;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-runfail-"));
    const store = new FsTaskStore(tmpDir);
    const idAllocator = new IdAllocator(tmpDir);
    broadcastCalls = [];
    orchestrator = {
      store,
      hub: {
        broadcast: (msg) => broadcastCalls.push(msg),
      },
      // runCard always rejects — simulates ENOENT / stale worktree / any post-202 failure
      runCard: async () => {
        throw new Error("ENOENT: stale worktree");
      },
      cancelRun: async () => {},
      isRunning: () => false,
    };
    server = await startHttpServer({ store, idAllocator, orchestrator, port: 0 });
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
      body: JSON.stringify({ title: "Test task", phase: 1, ...overrides }),
    });
    return res.json();
  }

  it("still returns 202 when runCard will fail asynchronously", async () => {
    const task = await createTask({ status: "ready" });
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    expect(res.status).toBe(202);
    // Drain the async rejection handler before afterEach tears down tmpDir,
    // otherwise the in-flight store write races with fs.rm cleanup.
    await vi.waitFor(() => expect(broadcastCalls.length).toBeGreaterThan(0));
  });

  it("persists blocked status on the card when runCard rejects", async () => {
    const task = await createTask({ status: "ready" });
    await fetch(`${baseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    await vi.waitFor(async () => {
      const updated = await orchestrator.store.get(task.id);
      expect(updated.status).toBe("blocked");
    });
  });

  it("appends the error message to the card body when runCard rejects", async () => {
    const task = await createTask({ status: "ready" });
    await fetch(`${baseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    await vi.waitFor(async () => {
      const updated = await orchestrator.store.get(task.id);
      expect(updated.body).toMatch(/ENOENT: stale worktree/);
    });
  });

  it("broadcasts a 'changed' event with blocked status over the hub when runCard rejects", async () => {
    const task = await createTask({ status: "ready" });
    await fetch(`${baseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    await vi.waitFor(() => {
      const changedBroadcast = broadcastCalls.find(
        (c) => c.type === "changed" && c.id === task.id && c.task?.status === "blocked"
      );
      expect(changedBroadcast).toBeDefined();
    });
  });
});
