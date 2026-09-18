import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";

/**
 * T-0383: `POST /api/tasks/:id/ready` -- a write channel that does not depend on in-page JS
 * `fetch` being reachable. The nightly-infra-prep sandbox's browser content filter sometimes
 * blocks in-page `fetch`, so the `ready` write silently doesn't happen even though the browser
 * itself can still submit a plain HTML `<form method="post">` (ordinary navigation, not script).
 *
 * Auth/CSRF: this route is guarded by a shared-secret token (`BOARD_READY_TOKEN`), checked
 * before the task store is ever touched. Without a configured token the route is disabled
 * (501) rather than silently open -- a bare form-POST channel with no token would be reachable
 * from ANY page a browser on this host loads (a plain `application/x-www-form-urlencoded` POST
 * is a CORS "simple request" and is not blocked by same-origin policy the way `fetch` is), so
 * unlike `PATCH /api/tasks/:id` (which needs a `fetch`/XHR with a JSON content-type, and so
 * already gets incidental CSRF protection from the browser's preflight requirement), this route
 * needs its own explicit guard. The token can be supplied as an `Authorization: Bearer` header
 * (direct HTTP callers) or a form field (a static HTML form's hidden `<input>`, no script
 * required). Deliberately NOT accepted as a query param -- a query string routinely ends up in
 * access logs, browser history, and an outbound `Referer` header, any of which would leak the
 * very secret this token exists to keep private, and a hidden form field already covers the
 * "no JS" use case a query param would have been for.
 */

let tasksDir;
let server;
let baseUrl;
const originalToken = process.env.BOARD_READY_TOKEN;

beforeEach(async () => {
  tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-ready-"));
  process.env.BOARD_READY_TOKEN = "test-ready-token";
  const store = new FsTaskStore(tasksDir);
  const idAllocator = new IdAllocator(tasksDir);
  server = await startHttpServer({ store, idAllocator, tasksDir, port: 0 });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (originalToken === undefined) delete process.env.BOARD_READY_TOKEN;
  else process.env.BOARD_READY_TOKEN = originalToken;
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tasksDir, { recursive: true, force: true });
});

async function createTask(overrides = {}) {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "A card", phase: 1, status: "backlog", ...overrides })
  });
  return res.json();
}

describe("POST /api/tasks/:id/ready", () => {
  it("moves a backlog card to ready given a valid token as a form field", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/ready`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent("test-ready-token")}`
    });

    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.status).toBe("ready");
  });

  it("accepts the token as an Authorization: Bearer header with a JSON body", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/ready`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-ready-token" },
      body: "{}"
    });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ready");
  });

  it("rejects a token supplied only as a query param -- it must never end up in logs/Referer", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/ready?token=test-ready-token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: ""
    });

    expect(res.status).toBe(403);
    const unchanged = await (await fetch(`${baseUrl}/api/tasks/${task.id}`)).json();
    expect(unchanged.status).toBe("backlog");
  });

  it("is reachable via a body a plain <form> POST produces -- form-encoded, no custom headers besides Content-Type", async () => {
    const task = await createTask();
    // Mirrors exactly what a browser sends for <form method="post" enctype="application/x-www-form-urlencoded">.
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/ready`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=test-ready-token&status=ready`
    });
    expect(res.status).toBe(200);
  });

  it("rejects a missing token with 403 before ever touching the store", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/ready`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: ""
    });

    expect(res.status).toBe(403);
    const unchanged = await (await fetch(`${baseUrl}/api/tasks/${task.id}`)).json();
    expect(unchanged.status).toBe("backlog");
  });

  it("rejects a wrong token with 403", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/ready`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent("wrong-token")}`
    });

    expect(res.status).toBe(403);
  });

  it("rejects an explicit non-ready target status with 400 -- this route only writes 'ready'", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/ready`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=test-ready-token&status=done`
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/ready/i);
    const unchanged = await (await fetch(`${baseUrl}/api/tasks/${task.id}`)).json();
    expect(unchanged.status).toBe("backlog");
  });

  it("returns 404 for a task id that does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/T-9999/ready`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=test-ready-token`
    });
    expect(res.status).toBe(404);
  });

  it("is disabled (501) when BOARD_READY_TOKEN is not configured", async () => {
    delete process.env.BOARD_READY_TOKEN;
    await new Promise((resolve) => server.close(resolve));
    const store = new FsTaskStore(tasksDir);
    const idAllocator = new IdAllocator(tasksDir);
    server = await startHttpServer({ store, idAllocator, tasksDir, port: 0 });
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const task = await createTask();
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/ready`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=anything`
    });

    expect(res.status).toBe(501);
  });

  it("PATCH /api/tasks/:id keeps working unchanged alongside the new route", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready" })
    });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ready");
  });

  it("rejects a malformed Content-Type with 400 rather than silently ignoring the body", async () => {
    const task = await createTask();

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}/ready`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: `token=test-ready-token`
    });

    expect(res.status).toBe(400);
  });
});
