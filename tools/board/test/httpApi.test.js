import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";

let tmpDir;
let server;
let baseUrl;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-"));
  const store = new FsTaskStore(tmpDir);
  const idAllocator = new IdAllocator(tmpDir);
  server = await startHttpServer({ store, idAllocator, port: 0 });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function validTaskBody(overrides = {}) {
  return {
    title: "Wire up the API",
    phase: 1,
    ...overrides
  };
}

describe("network binding", () => {
  it("refuses to start on any host other than 127.0.0.1", async () => {
    const store = new FsTaskStore(tmpDir);
    const idAllocator = new IdAllocator(tmpDir);
    expect(() => startHttpServer({ store, idAllocator, host: "0.0.0.0" })).toThrow(/127\.0\.0\.1/);
  });

  it("is actually bound to 127.0.0.1", () => {
    expect(server.address().address).toBe("127.0.0.1");
  });
});

describe("GET /api/tasks", () => {
  it("returns 200 and an empty array when no tasks exist", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns 200 with created tasks", async () => {
    await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validTaskBody({ title: "First" }))
    });
    const res = await fetch(`${baseUrl}/api/tasks`);
    expect(res.status).toBe(200);
    const tasks = await res.json();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("First");
  });
});

describe("POST /api/tasks", () => {
  it("returns 201 and allocates an id for a valid task", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validTaskBody())
    });
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.id).toBe("T-0001");
    expect(task.status).toBe("backlog");
    expect(task.depends_on).toEqual([]);
  });

  it("returns 400 when title is missing", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phase: 1 })
    });
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toMatch(/title/i);
  });

  it("returns 400 when phase is missing", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No phase" })
    });
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toMatch(/phase/i);
  });

  it("returns 400 for an invalid status enum value", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validTaskBody({ status: "bogus" }))
    });
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toMatch(/status/i);
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json"
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/tasks/:id", () => {
  it("returns 200 with the task when it exists", async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validTaskBody())
    });
    const { id } = await createRes.json();

    const res = await fetch(`${baseUrl}/api/tasks/${id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(id);
  });

  it("returns 404 when the task does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/T-9999`);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/tasks/:id", () => {
  async function createTask(overrides = {}) {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validTaskBody(overrides))
    });
    return res.json();
  }

  it("returns 200 and applies a partial update", async () => {
    const task = await createTask();
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready" })
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.status).toBe("ready");
    expect(updated.title).toBe(task.title);
  });

  it("returns 404 when patching a task that does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/T-9999`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready" })
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when the update value is invalid", async () => {
    const task = await createTask();
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "not-a-status" })
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when attempting to change the task id", async () => {
    const task = await createTask();
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "T-9999" })
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/tasks/:id dependency guard", () => {
  async function createTask(overrides = {}) {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validTaskBody(overrides))
    });
    return res.json();
  }

  it("rejects moving to in-progress when a dependency is not done", async () => {
    const dep = await createTask({ title: "Dependency" });
    const task = await createTask({ title: "Blocked", depends_on: [dep.id] });

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in-progress" })
    });

    expect(res.status).toBe(409);
    const payload = await res.json();
    expect(payload.error).toMatch(new RegExp(dep.id));

    const unchanged = await (await fetch(`${baseUrl}/api/tasks/${task.id}`)).json();
    expect(unchanged.status).not.toBe("in-progress");
  });

  it("allows moving to in-progress once all dependencies are done", async () => {
    const dep = await createTask({ title: "Dependency" });
    await fetch(`${baseUrl}/api/tasks/${dep.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" })
    });
    const task = await createTask({ title: "Unblocked", depends_on: [dep.id] });

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in-progress" })
    });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("in-progress");
  });

  it("rejects with a clear error and does not hang when the dependency graph has a cycle", async () => {
    const a = await createTask({ title: "A" });
    const b = await createTask({ title: "B", depends_on: [a.id] });
    await fetch(`${baseUrl}/api/tasks/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ depends_on: [b.id] })
    });

    const res = await fetch(`${baseUrl}/api/tasks/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in-progress" })
    });

    expect(res.status).toBe(409);
    const payload = await res.json();
    expect(payload.error).toMatch(/cycle/i);
  });

  it("does not guard status changes that are not a move to in-progress", async () => {
    const dep = await createTask({ title: "Dependency" });
    const task = await createTask({ title: "Blocked", depends_on: [dep.id] });

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready" })
    });

    expect(res.status).toBe(200);
  });
});

describe("routing edge cases", () => {
  it("returns 404 for an unknown path", async () => {
    const res = await fetch(`${baseUrl}/api/nope`);
    expect(res.status).toBe(404);
  });

  it("returns 405 for an unsupported method on a known route", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });
});
