import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PtyBridge } from "../src/server/ptyBridge.js";

function makeFakeSocket() {
  const ws = new EventEmitter();
  ws.OPEN = 1;
  ws.readyState = 1;
  ws.sent = [];
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  return ws;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let bridges = [];

function makeBridge(options = {}) {
  const bridge = new PtyBridge({ shell: "/bin/sh", args: [], ...options });
  bridges.push(bridge);
  return bridge;
}

afterEach(() => {
  for (const bridge of bridges) {
    bridge.close();
  }
  bridges = [];
});

describe("PtyBridge lifecycle", () => {
  it("spawns a real pty on connection and relays written input back as output", async () => {
    const bridge = makeBridge();
    const ws = makeFakeSocket();

    bridge.handleConnection(ws);

    expect(bridge.sessions.size).toBe(1);
    const pty = [...bridge.sessions][0];
    expect(isAlive(pty.pid)).toBe(true);

    ws.emit("message", JSON.stringify({ type: "input", data: "echo pty-hello\n" }));

    await vi.waitFor(() => {
      const combined = ws.sent.map((m) => m.data ?? "").join("");
      expect(combined).toContain("pty-hello");
    });
  });

  it("applies resize messages to the underlying pty", async () => {
    const bridge = makeBridge();
    const ws = makeFakeSocket();

    bridge.handleConnection(ws);
    const pty = [...bridge.sessions][0];
    const resizeSpy = vi.spyOn(pty, "resize");

    ws.emit("message", JSON.stringify({ type: "resize", cols: 120, rows: 40 }));

    expect(resizeSpy).toHaveBeenCalledWith(120, 40);
  });

  it("ignores malformed or unknown messages without throwing", async () => {
    const bridge = makeBridge();
    const ws = makeFakeSocket();

    bridge.handleConnection(ws);

    expect(() => ws.emit("message", "not json")).not.toThrow();
    expect(() => ws.emit("message", JSON.stringify({ type: "bogus" }))).not.toThrow();
    expect(bridge.sessions.size).toBe(1);
  });

  it("kills the child pty and drops the session when the socket disconnects (no orphan)", async () => {
    const bridge = makeBridge();
    const ws = makeFakeSocket();

    bridge.handleConnection(ws);
    const pty = [...bridge.sessions][0];
    const { pid } = pty;
    expect(isAlive(pid)).toBe(true);

    ws.emit("close");

    await vi.waitFor(() => {
      expect(isAlive(pid)).toBe(false);
    });
    expect(bridge.sessions.size).toBe(0);
  });

  it("close() kills every live session (used on server shutdown)", async () => {
    const bridge = makeBridge();
    const wsA = makeFakeSocket();
    const wsB = makeFakeSocket();
    bridge.handleConnection(wsA);
    bridge.handleConnection(wsB);
    const pids = [...bridge.sessions].map((pty) => pty.pid);
    expect(pids).toHaveLength(2);

    bridge.close();

    await vi.waitFor(() => {
      for (const pid of pids) {
        expect(isAlive(pid)).toBe(false);
      }
    });
  });
});
