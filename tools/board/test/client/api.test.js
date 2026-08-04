// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchTasks,
  patchTask,
  connectBoardSocket,
  runTask,
  cancelTask,
  createTask,
  deleteTask,
  fetchAgents,
  exportBacklog
} from "../../src/client/api.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("fetchTasks", () => {
  it("GETs /api/tasks and returns the parsed JSON array", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: "T-0001" }]
    });
    const tasks = await fetchTasks();
    expect(global.fetch).toHaveBeenCalledWith("/api/tasks");
    expect(tasks).toEqual([{ id: "T-0001" }]);
  });

  it("throws when the response is not ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchTasks()).rejects.toThrow(/500/);
  });
});

describe("patchTask", () => {
  it("PATCHes the task's own endpoint with a JSON body", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "T-0001", status: "ready" })
    });
    const result = await patchTask("T-0001", { status: "ready" });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/tasks/T-0001",
      expect.objectContaining({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ready" })
      })
    );
    expect(result).toEqual({ id: "T-0001", status: "ready" });
  });

  it("throws the server-provided error message on failure", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "bad status" })
    });
    await expect(patchTask("T-0001", { status: "bogus" })).rejects.toThrow("bad status");
  });
});

describe("runTask", () => {
  it("POSTs to the task's /run endpoint", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ id: "T-0001", status: "ready" })
    });
    const result = await runTask("T-0001");
    expect(global.fetch).toHaveBeenCalledWith("/api/tasks/T-0001/run", { method: "POST" });
    expect(result).toEqual({ id: "T-0001", status: "ready" });
  });

  it("throws the server-provided error message on failure", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "already has an active run" })
    });
    await expect(runTask("T-0001")).rejects.toThrow("already has an active run");
  });
});

describe("cancelTask", () => {
  it("POSTs to the task's /cancel endpoint and returns the resulting task", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "T-0001", status: "blocked" })
    });
    const result = await cancelTask("T-0001");
    expect(global.fetch).toHaveBeenCalledWith("/api/tasks/T-0001/cancel", { method: "POST" });
    expect(result).toEqual({ id: "T-0001", status: "blocked" });
  });

  it("throws the server-provided error message on failure", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "No active run for T-0001" })
    });
    await expect(cancelTask("T-0001")).rejects.toThrow("No active run for T-0001");
  });
});

describe("createTask", () => {
  it("POSTs to /api/tasks with a JSON body and returns the created task", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "T-0001", title: "New task" })
    });
    const result = await createTask({ title: "New task", phase: 1 });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/tasks",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New task", phase: 1 })
      })
    );
    expect(result).toEqual({ id: "T-0001", title: "New task" });
  });

  it("throws the server-provided error message on failure", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "title is required" })
    });
    await expect(createTask({ phase: 1 })).rejects.toThrow("title is required");
  });
});

describe("deleteTask", () => {
  it("DELETEs the task's own endpoint", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "T-0001", deleted: true })
    });
    const result = await deleteTask("T-0001");
    expect(global.fetch).toHaveBeenCalledWith("/api/tasks/T-0001", { method: "DELETE" });
    expect(result).toEqual({ id: "T-0001", deleted: true });
  });

  it("throws the server-provided error message on failure", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Cannot delete T-0001: status is "in-progress" (active run)' })
    });
    await expect(deleteTask("T-0001")).rejects.toThrow(/active run/);
  });
});

describe("fetchAgents", () => {
  it("GETs /api/agents and returns the parsed JSON array", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ["infra", "server"]
    });
    const agents = await fetchAgents();
    expect(global.fetch).toHaveBeenCalledWith("/api/agents");
    expect(agents).toEqual(["infra", "server"]);
  });

  it("throws when the response is not ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchAgents()).rejects.toThrow(/500/);
  });
});

describe("connectBoardSocket", () => {
  let originalWebSocket;

  beforeEach(() => {
    originalWebSocket = global.WebSocket;
  });

  afterEach(() => {
    global.WebSocket = originalWebSocket;
  });

  it("opens a ws:// connection to /ws/board on the current host and forwards parsed messages", () => {
    const instances = [];
    global.WebSocket = vi.fn().mockImplementation(function FakeWebSocket(url) {
      this.url = url;
      this.listeners = {};
      this.addEventListener = (type, cb) => {
        this.listeners[type] = cb;
      };
      instances.push(this);
    });

    const onMessage = vi.fn();
    const ws = connectBoardSocket(onMessage);

    expect(ws.url).toMatch(/^ws:\/\/.*\/ws\/board$/);
    ws.listeners.message({ data: JSON.stringify({ type: "changed", id: "T-0001" }) });
    expect(onMessage).toHaveBeenCalledWith({ type: "changed", id: "T-0001" });
  });

  it("silently ignores malformed message payloads", () => {
    global.WebSocket = vi.fn().mockImplementation(function FakeWebSocket(url) {
      this.url = url;
      this.listeners = {};
      this.addEventListener = (type, cb) => {
        this.listeners[type] = cb;
      };
    });

    const onMessage = vi.fn();
    const ws = connectBoardSocket(onMessage);
    expect(() => ws.listeners.message({ data: "{not json" })).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("exportBacklog", () => {
  it("calls navigateTo with /api/tasks/export/backlog", () => {
    const navigateTo = vi.fn();
    exportBacklog(navigateTo);
    expect(navigateTo).toHaveBeenCalledWith("/api/tasks/export/backlog");
  });

  it("uses window.location.assign as the default navigateTo", () => {
    const originalAssign = window.location.assign;
    window.location.assign = vi.fn();
    try {
      exportBacklog();
      expect(window.location.assign).toHaveBeenCalledWith("/api/tasks/export/backlog");
    } finally {
      window.location.assign = originalAssign;
    }
  });
});
