// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchTasks, patchTask, connectBoardSocket } from "../../src/client/api.js";

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
