import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";

/**
 * `GET /api/health` -- a liveness probe for the board's own HTTP API.
 *
 * Why it has to be cheap: the two things that ask "is the board up?" are a human at a
 * terminal and the deploy/restart tooling, and both ask at exactly the moments the board is
 * least healthy. A probe that reads the task store would report the board down whenever
 * SQLite is briefly locked (the nightly backup, an integrity-check run) -- flapping on
 * something that has nothing to do with whether the process is serving. So this route touches
 * no store, no git, and no filesystem: it answers from process state alone, and the "hostile
 * store" test below is what pins that.
 *
 * Everything it reports is already in memory: `taskStore` is the configured mode,
 * `activeRuns` is the orchestrator's in-process run-set size (the same signal `deploy.sh` and
 * the orphan reaper care about, previously only obtainable by fetching and parsing all ~200
 * cards from `/api/tasks`), and `uptimeSeconds` is `process.uptime()`.
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

beforeEach(async () => {
  tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-health-"));
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  await fs.rm(tasksDir, { recursive: true, force: true });
});

describe("GET /api/health", () => {
  it("returns 200 with a JSON body reporting status ok", async () => {
    await startServer();

    const res = await fetch(`${baseUrl}/api/health`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("is reachable with no request headers at all -- it is never behind a gate", async () => {
    await startServer();

    // Deliberately a bare request: no auth header, no content-type, no cookie. A liveness
    // probe that needs to be authenticated cannot tell you the process is up, only that your
    // credentials are good. If a gate is ever added in front of this API, `/api/health` stays
    // in front of it, and this test is what fails if it does not.
    const res = await fetch(`${baseUrl}/api/health`, { headers: {} });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it("reports the configured task-store mode", async () => {
    await startServer({ taskStoreKind: "db" });

    expect((await (await fetch(`${baseUrl}/api/health`)).json()).taskStore).toBe("db");
  });

  it("defaults the task-store mode to fs, matching startHttpServer's own default", async () => {
    await startServer();

    expect((await (await fetch(`${baseUrl}/api/health`)).json()).taskStore).toBe("fs");
  });

  it("reports whether a card run is currently in flight", async () => {
    const orchestrator = { hasActiveRuns: vi.fn(() => true) };
    await startServer({ orchestrator });

    expect((await (await fetch(`${baseUrl}/api/health`)).json()).activeRuns).toBe(true);
    expect(orchestrator.hasActiveRuns).toHaveBeenCalled();
  });

  it("reports activeRuns: false when the board has no orchestrator wired in", async () => {
    await startServer({ orchestrator: undefined });

    expect((await (await fetch(`${baseUrl}/api/health`)).json()).activeRuns).toBe(false);
  });

  it("reports a non-negative uptime", async () => {
    await startServer();

    const body = await (await fetch(`${baseUrl}/api/health`)).json();
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("stays 200 even when the task store is completely broken -- health must not flap on the DB", async () => {
    // The whole point of the route: a locked/corrupt SQLite file (nightly backup, integrity
    // check) must not make the board report itself down. Any store access at all would throw
    // here and surface as a 500.
    const hostileStore = {
      list: vi.fn(async () => {
        throw new Error("database is locked");
      }),
      get: vi.fn(async () => {
        throw new Error("database is locked");
      }),
      create: vi.fn(),
      update: vi.fn(),
      move: vi.fn(),
      remove: vi.fn()
    };
    await startServer({ store: hostileStore });

    const res = await fetch(`${baseUrl}/api/health`);

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
    expect(hostileStore.list).not.toHaveBeenCalled();
    expect(hostileStore.get).not.toHaveBeenCalled();
  });

  it("rejects a non-GET method with 405, not 404 -- the path is known", async () => {
    await startServer();

    const res = await fetch(`${baseUrl}/api/health`, { method: "POST" });

    expect(res.status).toBe(405);
    expect((await res.json()).error).toMatch(/not allowed/i);
  });

  it("does not shadow any other route -- an unknown /api path still 404s", async () => {
    await startServer();

    expect((await fetch(`${baseUrl}/api/healthz`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/health/extra`)).status).toBe(404);
  });
});
