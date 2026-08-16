import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";

let tmpDir;
let agentsDir;
let server;
let baseUrl;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-"));
  agentsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-agents-"));
  const store = new FsTaskStore(tmpDir);
  const idAllocator = new IdAllocator(tmpDir);
  server = await startHttpServer({ store, idAllocator, agentsDir, port: 0 });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(agentsDir, { recursive: true, force: true });
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

  it("defaults agent to 'generic' when not provided, never null", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validTaskBody())
    });
    const task = await res.json();
    expect(task.agent).toBe("generic");
  });

  it("defaults agent to 'generic' when explicitly sent as null", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validTaskBody({ agent: null }))
    });
    const task = await res.json();
    expect(task.agent).toBe("generic");
  });

  it("accepts an explicit agent: 'generic'", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validTaskBody({ agent: "generic" }))
    });
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.agent).toBe("generic");
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

describe("GET /api/agents", () => {
  it("returns 200 with an empty array when the agents directory has no agents", async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns 200 with assignable agent names, excluding reviewer", async () => {
    await fs.writeFile(path.join(agentsDir, "infra.md"), "---\nname: infra\n---\nbody", "utf8");
    await fs.writeFile(path.join(agentsDir, "server.md"), "---\nname: server\n---\nbody", "utf8");
    await fs.writeFile(path.join(agentsDir, "reviewer.md"), "---\nname: reviewer\n---\nbody", "utf8");

    const res = await fetch(`${baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["infra", "server"]);
  });

  it("includes planner in the New Card agent dropdown source, same as any other implementer agent", async () => {
    await fs.writeFile(path.join(agentsDir, "planner.md"), "---\nname: planner\n---\nbody", "utf8");
    await fs.writeFile(path.join(agentsDir, "reviewer.md"), "---\nname: reviewer\n---\nbody", "utf8");

    const res = await fetch(`${baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["planner"]);
  });

  it("includes generic in the New Card agent dropdown source, same as any other implementer agent", async () => {
    await fs.writeFile(path.join(agentsDir, "generic.md"), "---\nname: generic\n---\nbody", "utf8");
    await fs.writeFile(path.join(agentsDir, "infra.md"), "---\nname: infra\n---\nbody", "utf8");
    await fs.writeFile(path.join(agentsDir, "reviewer.md"), "---\nname: reviewer\n---\nbody", "utf8");

    const res = await fetch(`${baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["generic", "infra"]);
  });

  it("returns 200 with an empty array when no agentsDir is configured on the server", async () => {
    const bareStore = new FsTaskStore(tmpDir);
    const bareAllocator = new IdAllocator(tmpDir);
    const bareServer = await startHttpServer({ store: bareStore, idAllocator: bareAllocator, port: 0 });
    const { port } = bareServer.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/agents`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    await new Promise((resolve) => bareServer.close(resolve));
  });
});

describe("DELETE /api/tasks/:id", () => {
  async function createTask(overrides = {}) {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validTaskBody(overrides))
    });
    return res.json();
  }

  it("deletes an existing task and it is no longer retrievable", async () => {
    const task = await createTask();
    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/api/tasks/${task.id}`);
    expect(getRes.status).toBe(404);
  });

  it("returns 404 when deleting a task that does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/T-9999`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("returns 409 and refuses to delete a task that is in-progress", async () => {
    const task = await createTask();
    await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in-progress" })
    });

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const payload = await res.json();
    expect(payload.error).toMatch(/in-progress/i);

    const stillThere = await fetch(`${baseUrl}/api/tasks/${task.id}`);
    expect(stillThere.status).toBe(200);
  });

  it("returns 409 and refuses to delete a task that is in validation", async () => {
    const task = await createTask();
    await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "validation" })
    });

    const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const payload = await res.json();
    expect(payload.error).toMatch(/validation/i);
  });

  it("allows deleting a task in backlog, ready, review, done, or blocked", async () => {
    for (const status of ["backlog", "ready", "review", "done", "blocked"]) {
      const task = await createTask({ title: `task-${status}` });
      await fetch(`${baseUrl}/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
      const res = await fetch(`${baseUrl}/api/tasks/${task.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);
    }
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

describe("POST /api/tasks/:id/run and /cancel without an orchestrator configured", () => {
  it("returns 501 for /run when no orchestrator is wired", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/T-9999/run`, { method: "POST" });
    expect(res.status).toBe(501);
  });

  it("returns 501 for /cancel when no orchestrator is wired", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/T-9999/cancel`, { method: "POST" });
    expect(res.status).toBe(501);
  });
});

describe("POST /api/tasks/:id/run and /cancel with an orchestrator", () => {
  let orchTmpDir;
  let orchServer;
  let orchBaseUrl;
  let orchestrator;

  beforeEach(async () => {
    orchTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-orch-"));
    const store = new FsTaskStore(orchTmpDir);
    const idAllocator = new IdAllocator(orchTmpDir);
    orchestrator = {
      store,
      running: new Set(),
      runCard: async (id) => {
        orchestrator.running.add(id);
      },
      cancelRun: async (id) => {
        if (!orchestrator.running.has(id)) {
          throw new Error(`No active run for ${id}`);
        }
        orchestrator.running.delete(id);
        await store.update(id, { status: "blocked" });
      },
      isRunning: (id) => orchestrator.running.has(id)
    };
    orchServer = await startHttpServer({ store, idAllocator, orchestrator, port: 0 });
    const { port } = orchServer.address();
    orchBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => orchServer.close(resolve));
    await fs.rm(orchTmpDir, { recursive: true, force: true });
  });

  async function createTask(overrides = {}) {
    const res = await fetch(`${orchBaseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validTaskBody(overrides))
    });
    return res.json();
  }

  it("returns 404 when running a task that does not exist", async () => {
    const res = await fetch(`${orchBaseUrl}/api/tasks/T-9999/run`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when running a task that is not ready", async () => {
    const task = await createTask({ status: "backlog" });
    const res = await fetch(`${orchBaseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    expect(res.status).toBe(409);
    const payload = await res.json();
    expect(payload.error).toMatch(/ready/i);
  });

  it("returns 409 when running a card assigned to the dispatch escalation sentinel", async () => {
    const task = await createTask({ status: "ready", agent: "dispatch" });
    const res = await fetch(`${orchBaseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    expect(res.status).toBe(409);
    const payload = await res.json();
    expect(payload.error).toMatch(/dispatch/i);
    expect(orchestrator.isRunning(task.id)).toBe(false);
  });

  it("returns 409 when running a retired task", async () => {
    const task = await createTask({ status: "retired" });
    const res = await fetch(`${orchBaseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    expect(res.status).toBe(409);
    const payload = await res.json();
    expect(payload.error).toMatch(/ready/i);
  });

  it("accepts a run on a ready card and kicks off the orchestrator without blocking the response", async () => {
    const task = await createTask({ status: "ready" });
    const res = await fetch(`${orchBaseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(orchestrator.isRunning(task.id)).toBe(true));
  });

  it("accepts a run on a review card -- re-running to continue existing work, not just a fresh ready card", async () => {
    const task = await createTask({ status: "review" });
    const res = await fetch(`${orchBaseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(orchestrator.isRunning(task.id)).toBe(true));
  });

  it("accepts a run on a blocked card -- re-running to continue existing work instead of leaving it stuck", async () => {
    const task = await createTask({ status: "blocked" });
    const res = await fetch(`${orchBaseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(orchestrator.isRunning(task.id)).toBe(true));
  });

  // RUN-3 / LC-5 (docs/board-invariants.md): the Run/Re-run button hits this route
  // directly, bypassing the PATCH-to-in-progress path that "PATCH /api/tasks/:id
  // dependency guard" above tests. A ready card with unmet own dependencies renders
  // the red "blocked" dot (computeDependencyStatus in board.js) -- the Run button
  // must not be able to start work the dot says isn't ready.
  describe("dependency guard on run (RUN-3 / LC-5)", () => {
    it("returns 409 running a ready card whose own dependency is not done", async () => {
      const dep = await createTask({ status: "backlog" });
      const task = await createTask({ status: "ready", depends_on: [dep.id] });

      const res = await fetch(`${orchBaseUrl}/api/tasks/${task.id}/run`, { method: "POST" });

      expect(res.status).toBe(409);
      const payload = await res.json();
      expect(payload.error).toMatch(new RegExp(dep.id));
      expect(orchestrator.isRunning(task.id)).toBe(false);
    });

    it("returns 409 re-running a blocked card whose own dependency is not done", async () => {
      const dep = await createTask({ status: "in-progress" });
      const task = await createTask({ status: "blocked", depends_on: [dep.id] });

      const res = await fetch(`${orchBaseUrl}/api/tasks/${task.id}/run`, { method: "POST" });

      expect(res.status).toBe(409);
      expect(orchestrator.isRunning(task.id)).toBe(false);
    });

    it("returns 409 running a card whose dependency graph has a cycle", async () => {
      const a = await createTask({ status: "ready" });
      const b = await createTask({ status: "ready", depends_on: [a.id] });
      await fetch(`${orchBaseUrl}/api/tasks/${a.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ depends_on: [b.id] })
      });

      const res = await fetch(`${orchBaseUrl}/api/tasks/${a.id}/run`, { method: "POST" });

      expect(res.status).toBe(409);
      const payload = await res.json();
      expect(payload.error).toMatch(/cycle/i);
    });

    it("allows running a ready card once its own dependency is done", async () => {
      const dep = await createTask({ status: "done" });
      const task = await createTask({ status: "ready", depends_on: [dep.id] });

      const res = await fetch(`${orchBaseUrl}/api/tasks/${task.id}/run`, { method: "POST" });

      expect(res.status).toBe(202);
      await vi.waitFor(() => expect(orchestrator.isRunning(task.id)).toBe(true));
    });

    it("allows running a card with no dependencies (unaffected by the guard)", async () => {
      const task = await createTask({ status: "ready", depends_on: [] });

      const res = await fetch(`${orchBaseUrl}/api/tasks/${task.id}/run`, { method: "POST" });

      expect(res.status).toBe(202);
      await vi.waitFor(() => expect(orchestrator.isRunning(task.id)).toBe(true));
    });
  });

  it("returns 409 when running a card that already has an active run", async () => {
    const task = await createTask({ status: "ready" });
    await fetch(`${orchBaseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    await vi.waitFor(() => expect(orchestrator.isRunning(task.id)).toBe(true));

    const res = await fetch(`${orchBaseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("returns 409 cancelling a card with no active run", async () => {
    const task = await createTask({ status: "ready" });
    const res = await fetch(`${orchBaseUrl}/api/tasks/${task.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("cancels an active run and reflects the resulting task state", async () => {
    const task = await createTask({ status: "ready" });
    await fetch(`${orchBaseUrl}/api/tasks/${task.id}/run`, { method: "POST" });
    await vi.waitFor(() => expect(orchestrator.isRunning(task.id)).toBe(true));

    const res = await fetch(`${orchBaseUrl}/api/tasks/${task.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.status).toBe("blocked");
  });

  it("returns 404 running/cancelling an unknown route method combination gracefully", async () => {
    const res = await fetch(`${orchBaseUrl}/api/tasks/T-0001/run`, { method: "GET" });
    expect(res.status).toBe(405);
  });
});

describe("GET /api/git/status", () => {
  let gitServer;
  let gitBaseUrl;
  let gitTmpDir;
  let gitInfoImpl;

  beforeEach(async () => {
    gitTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-git-"));
    const store = new FsTaskStore(gitTmpDir);
    const idAllocator = new IdAllocator(gitTmpDir);
    gitInfoImpl = vi.fn().mockResolvedValue({
      branch: "feature/T-0116",
      head: "abc1234567890abcdef1234567890abcdef123456",
      headTimestamp: "2026-08-04T10:00:00+00:00"
    });
    gitServer = await startHttpServer({ store, idAllocator, gitInfoImpl, port: 0 });
    const { port } = gitServer.address();
    gitBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => gitServer.close(resolve));
    await fs.rm(gitTmpDir, { recursive: true, force: true });
  });

  it("returns 200 with branch, head, and headTimestamp", async () => {
    const res = await fetch(`${gitBaseUrl}/api/git/status`);
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.branch).toBe("feature/T-0116");
    expect(payload.head).toBe("abc1234567890abcdef1234567890abcdef123456");
    expect(payload.headTimestamp).toBe("2026-08-04T10:00:00+00:00");
  });

  it("calls gitInfoImpl exactly once per request", async () => {
    await fetch(`${gitBaseUrl}/api/git/status`);
    expect(gitInfoImpl).toHaveBeenCalledTimes(1);
  });

  it("returns 200 with null fields when no gitInfoImpl is configured", async () => {
    const bareDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-noGit-"));
    const bareStore = new FsTaskStore(bareDir);
    const bareAllocator = new IdAllocator(bareDir);
    const bareServer = await startHttpServer({ store: bareStore, idAllocator: bareAllocator, port: 0 });
    const { port } = bareServer.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/git/status`);
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.branch).toBeNull();
    expect(payload.head).toBeNull();
    expect(payload.headTimestamp).toBeNull();
    await new Promise((resolve) => bareServer.close(resolve));
    await fs.rm(bareDir, { recursive: true, force: true });
  });

  it("returns 405 for non-GET methods on /api/git/status", async () => {
    const res = await fetch(`${gitBaseUrl}/api/git/status`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("GET /api/tasks/export/backlog", () => {
  async function createTask(overrides = {}) {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validTaskBody(overrides))
    });
    return res.json();
  }

  it("returns 200 with text/plain content type", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/export/backlog`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
  });

  it("returns a Content-Disposition attachment header referencing backlog", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/export/backlog`);
    const cd = res.headers.get("content-disposition");
    expect(cd).toMatch(/attachment/);
    expect(cd).toMatch(/backlog/);
  });

  it("includes only backlog task titles, not tasks of other statuses", async () => {
    await createTask({ title: "Alpha task", status: "backlog" });
    await createTask({ title: "Beta task", status: "ready" });
    const res = await fetch(`${baseUrl}/api/tasks/export/backlog`);
    const text = await res.text();
    expect(text).toContain("Alpha task");
    expect(text).not.toContain("Beta task");
  });

  it("includes task metadata (id, priority, agent, phase) in the export", async () => {
    await createTask({ title: "Meta task", priority: "P0", agent: "infra", phase: 3, status: "backlog" });
    const res = await fetch(`${baseUrl}/api/tasks/export/backlog`);
    const text = await res.text();
    expect(text).toContain("T-0001");
    expect(text).toContain("P0");
    expect(text).toContain("infra");
    expect(text).toContain("3");
  });

  it("includes status in the export for each backlog task", async () => {
    await createTask({ title: "Status task", status: "backlog" });
    const res = await fetch(`${baseUrl}/api/tasks/export/backlog`);
    const text = await res.text();
    expect(text).toContain("Status: backlog");
  });

  it("includes depends_on in the export listing dependency ids when present", async () => {
    const dep = await createTask({ title: "Dep task" });
    await createTask({ title: "Dependent task", depends_on: [dep.id] });
    const res = await fetch(`${baseUrl}/api/tasks/export/backlog`);
    const text = await res.text();
    // The dependent task's section should list the dependency id
    expect(text).toMatch(/Depends on:.*T-0001/);
  });

  it("includes depends_on showing none when the task has no dependencies", async () => {
    await createTask({ title: "Solo task" });
    const res = await fetch(`${baseUrl}/api/tasks/export/backlog`);
    const text = await res.text();
    expect(text).toContain("Depends on: none");
  });

  it("indicates zero tasks when there are no backlog tasks", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/export/backlog`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("0 tasks");
  });

  it("returns 405 for non-GET methods on the export route", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/export/backlog`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("GET /api/tasks/export/done", () => {
  async function createTask(overrides = {}) {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validTaskBody(overrides))
    });
    return res.json();
  }

  it("returns 200 with text/plain content type", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/export/done`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
  });

  it("returns a Content-Disposition attachment header referencing done", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/export/done`);
    const cd = res.headers.get("content-disposition");
    expect(cd).toMatch(/attachment/);
    expect(cd).toMatch(/done/);
  });

  it("includes only done task titles, not tasks of other statuses", async () => {
    await createTask({ title: "Finished task", status: "done" });
    await createTask({ title: "Pending task", status: "backlog" });
    const res = await fetch(`${baseUrl}/api/tasks/export/done`);
    const text = await res.text();
    expect(text).toContain("Finished task");
    expect(text).not.toContain("Pending task");
  });

  it("includes task metadata (id, priority, agent, phase) in the export", async () => {
    await createTask({ title: "Meta done task", priority: "P1", agent: "server", phase: 2, status: "done" });
    const res = await fetch(`${baseUrl}/api/tasks/export/done`);
    const text = await res.text();
    expect(text).toContain("T-0001");
    expect(text).toContain("P1");
    expect(text).toContain("server");
    expect(text).toContain("2");
  });

  it("indicates zero tasks when there are no done tasks", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/export/done`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("0 tasks");
  });

  it("returns 405 for non-GET methods on the done export route", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/export/done`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});
