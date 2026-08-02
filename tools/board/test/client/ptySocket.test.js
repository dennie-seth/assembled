// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connectPtySocket, sendPtyInput, sendPtyResize } from "../../src/client/ptySocket.js";

describe("connectPtySocket", () => {
  let originalWebSocket;

  beforeEach(() => {
    originalWebSocket = global.WebSocket;
  });

  afterEach(() => {
    global.WebSocket = originalWebSocket;
  });

  it("opens a ws:// connection to /ws/pty on the current host and forwards parsed messages", () => {
    global.WebSocket = vi.fn().mockImplementation(function FakeWebSocket(url) {
      this.url = url;
      this.listeners = {};
      this.addEventListener = (type, cb) => {
        this.listeners[type] = cb;
      };
    });

    const onMessage = vi.fn();
    const ws = connectPtySocket(onMessage);

    expect(ws.url).toMatch(/^ws:\/\/.*\/ws\/pty$/);
    ws.listeners.message({ data: JSON.stringify({ type: "data", data: "hi" }) });
    expect(onMessage).toHaveBeenCalledWith({ type: "data", data: "hi" });
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
    const ws = connectPtySocket(onMessage);
    expect(() => ws.listeners.message({ data: "{not json" })).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });
});

function fakeSocket(readyState) {
  return { OPEN: 1, readyState, send: vi.fn() };
}

describe("sendPtyInput", () => {
  it("sends an input envelope when the socket is open", () => {
    const ws = fakeSocket(1);
    sendPtyInput(ws, "ls\n");
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "input", data: "ls\n" }));
  });

  it("does nothing when the socket is not open", () => {
    const ws = fakeSocket(0);
    sendPtyInput(ws, "ls\n");
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe("sendPtyResize", () => {
  it("sends a resize envelope when the socket is open", () => {
    const ws = fakeSocket(1);
    sendPtyResize(ws, 120, 40);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
  });

  it("does nothing when the socket is not open", () => {
    const ws = fakeSocket(0);
    sendPtyResize(ws, 120, 40);
    expect(ws.send).not.toHaveBeenCalled();
  });
});
