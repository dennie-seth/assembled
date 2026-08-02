// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createTerminalPanel } from "../../src/client/terminalPanel.js";

function makeFakeTerm() {
  const handlers = {};
  return {
    open: vi.fn(),
    write: vi.fn(),
    dispose: vi.fn(),
    loadAddon: vi.fn(),
    focus: vi.fn(),
    onData: (cb) => {
      handlers.data = cb;
    },
    onResize: (cb) => {
      handlers.resize = cb;
    },
    _handlers: handlers
  };
}

function makeFakeFitAddon() {
  return { fit: vi.fn() };
}

function makeFakeSocket() {
  return { OPEN: 1, readyState: 1, close: vi.fn(), send: vi.fn() };
}

function ctorReturning(value) {
  return vi.fn().mockImplementation(function FakeCtor() {
    return value;
  });
}

describe("createTerminalPanel", () => {
  it("opens the terminal in the container and fits it immediately", () => {
    const term = makeFakeTerm();
    const fitAddon = makeFakeFitAddon();
    const root = document.createElement("div");

    createTerminalPanel({
      root,
      TerminalCtor: ctorReturning(term),
      FitAddonCtor: ctorReturning(fitAddon),
      connect: vi.fn(() => makeFakeSocket())
    });

    expect(term.open).toHaveBeenCalledWith(root);
    expect(term.loadAddon).toHaveBeenCalledWith(fitAddon);
    expect(fitAddon.fit).toHaveBeenCalled();
  });

  it("re-fits on the next animation frame to correct for layout not settled at mount time", () => {
    const term = makeFakeTerm();
    const fitAddon = makeFakeFitAddon();
    let frameCallback;

    createTerminalPanel({
      root: document.createElement("div"),
      TerminalCtor: ctorReturning(term),
      FitAddonCtor: ctorReturning(fitAddon),
      connect: vi.fn(() => makeFakeSocket()),
      requestFrame: (cb) => {
        frameCallback = cb;
      }
    });

    const callsBeforeFrame = fitAddon.fit.mock.calls.length;
    frameCallback();

    expect(fitAddon.fit.mock.calls.length).toBe(callsBeforeFrame + 1);
  });

  it("forwards keystrokes typed into the terminal to the socket as input messages", () => {
    const term = makeFakeTerm();
    const ws = makeFakeSocket();
    const sendInputImpl = vi.fn();

    createTerminalPanel({
      root: document.createElement("div"),
      TerminalCtor: ctorReturning(term),
      FitAddonCtor: ctorReturning(makeFakeFitAddon()),
      connect: vi.fn(() => ws),
      sendInputImpl
    });

    term._handlers.data("ls\n");

    expect(sendInputImpl).toHaveBeenCalledWith(ws, "ls\n");
  });

  it("writes incoming socket 'data' messages to the terminal", () => {
    const term = makeFakeTerm();
    let onMessage;

    createTerminalPanel({
      root: document.createElement("div"),
      TerminalCtor: ctorReturning(term),
      FitAddonCtor: ctorReturning(makeFakeFitAddon()),
      connect: vi.fn((cb) => {
        onMessage = cb;
        return makeFakeSocket();
      })
    });

    onMessage({ type: "data", data: "hello\r\n" });

    expect(term.write).toHaveBeenCalledWith("hello\r\n");
  });

  it("writes an exit notice when the pty process exits", () => {
    const term = makeFakeTerm();
    let onMessage;

    createTerminalPanel({
      root: document.createElement("div"),
      TerminalCtor: ctorReturning(term),
      FitAddonCtor: ctorReturning(makeFakeFitAddon()),
      connect: vi.fn((cb) => {
        onMessage = cb;
        return makeFakeSocket();
      })
    });

    onMessage({ type: "exit", code: 0, signal: null });

    expect(term.write).toHaveBeenCalledWith(expect.stringContaining("exited"));
  });

  it("sends a resize message and re-fits when the terminal reports a resize", () => {
    const term = makeFakeTerm();
    const fitAddon = makeFakeFitAddon();
    const ws = makeFakeSocket();
    const sendResizeImpl = vi.fn();

    createTerminalPanel({
      root: document.createElement("div"),
      TerminalCtor: ctorReturning(term),
      FitAddonCtor: ctorReturning(fitAddon),
      connect: vi.fn(() => ws),
      sendResizeImpl
    });

    term._handlers.resize({ cols: 132, rows: 43 });

    expect(sendResizeImpl).toHaveBeenCalledWith(ws, 132, 43);
  });

  it("re-fits when the window resizes", () => {
    const fitAddon = makeFakeFitAddon();

    createTerminalPanel({
      root: document.createElement("div"),
      TerminalCtor: ctorReturning(makeFakeTerm()),
      FitAddonCtor: ctorReturning(fitAddon),
      connect: vi.fn(() => makeFakeSocket())
    });
    fitAddon.fit.mockClear();

    window.dispatchEvent(new Event("resize"));

    expect(fitAddon.fit).toHaveBeenCalled();
  });

  it("dispose() closes the socket, disposes the terminal, and stops listening for window resize", () => {
    const term = makeFakeTerm();
    const fitAddon = makeFakeFitAddon();
    const ws = makeFakeSocket();

    const panel = createTerminalPanel({
      root: document.createElement("div"),
      TerminalCtor: ctorReturning(term),
      FitAddonCtor: ctorReturning(fitAddon),
      connect: vi.fn(() => ws)
    });

    panel.dispose();

    expect(ws.close).toHaveBeenCalled();
    expect(term.dispose).toHaveBeenCalled();

    fitAddon.fit.mockClear();
    window.dispatchEvent(new Event("resize"));
    expect(fitAddon.fit).not.toHaveBeenCalled();
  });
});

describe("createTerminalPanel -- auto-focus", () => {
  it("focuses the terminal as soon as the panel is created (visible by default)", () => {
    const term = makeFakeTerm();

    createTerminalPanel({
      root: document.createElement("div"),
      TerminalCtor: ctorReturning(term),
      FitAddonCtor: ctorReturning(makeFakeFitAddon()),
      connect: vi.fn(() => makeFakeSocket())
    });

    expect(term.focus).toHaveBeenCalled();
  });

  it("exposes a focus() method that refocuses the terminal", () => {
    const term = makeFakeTerm();

    const panel = createTerminalPanel({
      root: document.createElement("div"),
      TerminalCtor: ctorReturning(term),
      FitAddonCtor: ctorReturning(makeFakeFitAddon()),
      connect: vi.fn(() => makeFakeSocket())
    });
    term.focus.mockClear();

    panel.focus();

    expect(term.focus).toHaveBeenCalledTimes(1);
  });

  it("focuses the terminal when the wider panel area (not just the xterm mount) is clicked", () => {
    const term = makeFakeTerm();
    const root = document.createElement("div");
    const panelRoot = document.createElement("div");
    panelRoot.appendChild(root);
    const header = document.createElement("div");
    panelRoot.appendChild(header);

    createTerminalPanel({
      root,
      panelRoot,
      TerminalCtor: ctorReturning(term),
      FitAddonCtor: ctorReturning(makeFakeFitAddon()),
      connect: vi.fn(() => makeFakeSocket())
    });
    term.focus.mockClear();

    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(term.focus).toHaveBeenCalledTimes(1);
  });

  it("defaults panelRoot to root when not given, so clicking the mount still focuses", () => {
    const term = makeFakeTerm();
    const root = document.createElement("div");

    createTerminalPanel({
      root,
      TerminalCtor: ctorReturning(term),
      FitAddonCtor: ctorReturning(makeFakeFitAddon()),
      connect: vi.fn(() => makeFakeSocket())
    });
    term.focus.mockClear();

    root.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(term.focus).toHaveBeenCalledTimes(1);
  });

  it("dispose() stops listening for panel clicks", () => {
    const term = makeFakeTerm();
    const root = document.createElement("div");
    const panelRoot = document.createElement("div");
    panelRoot.appendChild(root);

    const panel = createTerminalPanel({
      root,
      panelRoot,
      TerminalCtor: ctorReturning(term),
      FitAddonCtor: ctorReturning(makeFakeFitAddon()),
      connect: vi.fn(() => makeFakeSocket())
    });
    panel.dispose();
    term.focus.mockClear();

    panelRoot.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(term.focus).not.toHaveBeenCalled();
  });
});
