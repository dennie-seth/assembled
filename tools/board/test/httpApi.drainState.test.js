import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";

/**
 * WIP gate T-F (drain mode, spec §9): "the blocking window and expected next reconsideration
 * time are shown on the card and the board." `GET /api/poller` already shows the aggregate (see
 * httpApi.poller.test.js); this file covers the per-card surface -- a `drain_state` computed
 * field, same opt-in-via-`fields=` mechanism T-0383 already established for `dependency_status`/
 * `last_activity_at` (see httpApi.taskQuery.test.js), sourced from whatever the wired
 * auto-launch poller's own `getStatus().drain` already tracks (no extra store read, no new
 * persistence -- see autoLaunchPoller.js/drainMode.js).
 */

let tasksDir;
let server;
let baseUrl;

function fakePoller(drain = {}) {
  return {
    getStatus: vi.fn(() => ({
      enabled: true,
      intervalMs: 1000,
      usageMax: 0.8,
      running: true,
      lastTickAt: null,
      nextTickAt: null,
      lastResult: null,
      activeRun: false,
      drain
    }))
  };
}

function makeTask(overrides = {}) {
  return {
    id: "T-0001",
    title: "A card",
    status: "ready",
    priority: "P1",
    phase: 1,
    agent: "infra",
    depends_on: [],
    created: "2026-08-29",
    body: "",
    ...overrides
  };
}

beforeEach(async () => {
  tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-drainstate-"));
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  await fs.rm(tasksDir, { recursive: true, force: true });
});

async function startServer(overrides = {}) {
  const store = new FsTaskStore(tasksDir);
  const idAllocator = new IdAllocator(tasksDir);
  server = await startHttpServer({ store, idAllocator, tasksDir, port: 0, ...overrides });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return server;
}

describe("GET /api/tasks?fields=...,drain_state", () => {
  it("projects the poller's tracked drain state for a card that is currently waiting", async () => {
    const store = new FsTaskStore(tasksDir);
    await store.create(makeTask({ id: "T-0001" }));
    const drain = {
      "T-0001": { status: "waiting", blockingWindow: "seven_day", nextReconsiderationAtMs: 1_700_500_000_000, agingBoost: 2 }
    };
    await startServer({ autoLaunchPoller: fakePoller(drain) });

    const res = await fetch(`${baseUrl}/api/tasks?fields=id,drain_state`);
    expect(res.status).toBe(200);
    const [projected] = await res.json();
    expect(projected).toEqual({ id: "T-0001", drain_state: drain["T-0001"] });
  });

  it("is null for a card the poller is not currently tracking", async () => {
    const store = new FsTaskStore(tasksDir);
    await store.create(makeTask({ id: "T-0001" }));
    await startServer({ autoLaunchPoller: fakePoller({}) });

    const res = await fetch(`${baseUrl}/api/tasks?fields=id,drain_state`);
    const [projected] = await res.json();
    expect(projected.drain_state).toBeNull();
  });

  it("is null for every card when no poller is wired into this server", async () => {
    const store = new FsTaskStore(tasksDir);
    await store.create(makeTask({ id: "T-0001" }));
    await startServer();

    const res = await fetch(`${baseUrl}/api/tasks?fields=id,drain_state`);
    const [projected] = await res.json();
    expect(projected.id).toBe("T-0001");
    expect(projected.drain_state).toBeNull();
  });

  it("never reads drain state into the DEFAULT (no fields=) response -- byte-identical to before this card", async () => {
    const store = new FsTaskStore(tasksDir);
    await store.create(makeTask({ id: "T-0001" }));
    const drain = { "T-0001": { status: "waiting", blockingWindow: "five_hour" } };
    await startServer({ autoLaunchPoller: fakePoller(drain) });

    const res = await fetch(`${baseUrl}/api/tasks`);
    const [task] = await res.json();
    expect(task).not.toHaveProperty("drain_state");
  });
});
