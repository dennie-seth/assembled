import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";

/**
 * T-0383: `GET /api/poller` -- the nightly-infra-prep task currently has to read
 * `autoLaunchEnabledFromEnv()`/`autoLaunchIntervalMsFromEnv()`/`autoLaunchUsageMaxFromEnv()` or
 * the systemd drop-in to know whether the auto-launch poller is on. This route answers the same
 * question over plain HTTP, from whatever the poller already tracks in memory -- no repo read,
 * no unit-file read.
 */

let tasksDir;
let server;
let baseUrl;

async function startServer(overrides = {}) {
  const store = new FsTaskStore(tasksDir);
  const idAllocator = new IdAllocator(tasksDir);
  server = await startHttpServer({ store, idAllocator, tasksDir, port: 0, ...overrides });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return server;
}

function fakePoller(overrides = {}) {
  return {
    getStatus: vi.fn(() => ({
      enabled: true,
      intervalMs: 18_000_000,
      usageMax: 0.8,
      running: true,
      lastTickAt: "2026-09-18T00:00:00.000Z",
      nextTickAt: "2026-09-18T05:00:00.000Z",
      lastResult: { kind: "skip", reason: "usage 0.9 >= max 0.8", cardId: null },
      activeRun: false,
      ...overrides
    }))
  };
}

beforeEach(async () => {
  tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-poller-"));
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  await fs.rm(tasksDir, { recursive: true, force: true });
});

describe("GET /api/poller", () => {
  it("returns 200 with the poller's own getStatus() payload", async () => {
    const autoLaunchPoller = fakePoller();
    await startServer({ autoLaunchPoller });

    const res = await fetch(`${baseUrl}/api/poller`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body).toMatchObject({
      enabled: true,
      intervalMs: 18_000_000,
      usageMax: 0.8,
      running: true,
      activeRun: false
    });
    expect(body.lastTickAt).toBe("2026-09-18T00:00:00.000Z");
    expect(body.nextTickAt).toBe("2026-09-18T05:00:00.000Z");
    expect(body.lastResult).toEqual({ kind: "skip", reason: "usage 0.9 >= max 0.8", cardId: null });
    expect(autoLaunchPoller.getStatus).toHaveBeenCalled();
  });

  it("includes at least enabled, intervalMs and usageMax (acceptance minimum)", async () => {
    const autoLaunchPoller = fakePoller({ enabled: false, intervalMs: 0, usageMax: 0.5 });
    await startServer({ autoLaunchPoller });

    const body = await (await fetch(`${baseUrl}/api/poller`)).json();
    expect(body).toHaveProperty("enabled", false);
    expect(body).toHaveProperty("intervalMs", 0);
    expect(body).toHaveProperty("usageMax", 0.5);
  });

  it("never reads the task store -- it is a report of in-process poller state only", async () => {
    const listSpy = vi.fn();
    const store = { list: listSpy, get: vi.fn() };
    const idAllocator = new IdAllocator(tasksDir);
    const autoLaunchPoller = fakePoller();
    server = await startHttpServer({ store, idAllocator, tasksDir, autoLaunchPoller, port: 0 });
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    await fetch(`${baseUrl}/api/poller`);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("degrades gracefully to env-derived config when no poller is wired into this server", async () => {
    delete process.env.AUTO_LAUNCH_ENABLED;
    await startServer();

    const res = await fetch(`${baseUrl}/api/poller`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(typeof body.intervalMs).toBe("number");
    expect(typeof body.usageMax).toBe("number");
    expect(body.lastTickAt).toBeNull();
  });

  it("rejects a non-GET method with 405", async () => {
    await startServer({ autoLaunchPoller: fakePoller() });

    const res = await fetch(`${baseUrl}/api/poller`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("is reachable with no request headers -- same posture as /api/health", async () => {
    await startServer({ autoLaunchPoller: fakePoller() });

    const res = await fetch(`${baseUrl}/api/poller`, { headers: {} });
    expect(res.status).toBe(200);
  });
});
