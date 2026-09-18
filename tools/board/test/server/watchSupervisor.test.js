import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createWatchSupervisor } from "../../src/server/watchSupervisor.js";

/**
 * T-0385: `node --watch` restarts the deployed board process on any changed file,
 * unconditionally -- bypassing serviceRestart.js's active-run guard entirely, which is what
 * tore the API listener down mid-run during the #394/#395 incident even though the guard had
 * already logged "restart deferred until idle". `createWatchSupervisor` replaces `node --watch`
 * with a supervisor that applies the exact same `detectLiveRun` signal `npm run deploy`'s
 * live-run check already uses before ever restarting the watched child process.
 */

function makeLogger() {
  return { log: vi.fn(), error: vi.fn() };
}

function makeFakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal) => {
    queueMicrotask(() => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
    });
  });
  return child;
}

function makeWatcher() {
  const watcher = new EventEmitter();
  watcher.close = vi.fn(async () => {});
  return watcher;
}

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("createWatchSupervisor", () => {
  let spawnFn;
  let watcher;
  let watchFn;
  let detectLiveRunFn;
  let logger;

  beforeEach(() => {
    vi.useFakeTimers();
    watcher = makeWatcher();
    spawnFn = vi.fn(() => makeFakeChild());
    watchFn = vi.fn(() => watcher);
    detectLiveRunFn = vi.fn().mockResolvedValue({ live: false });
    logger = makeLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function make(overrides = {}) {
    return createWatchSupervisor({
      entryPath: "/fake/index.js",
      watchPaths: ["/fake/src"],
      runsDir: "/fake/tasks/.runs",
      boardDirs: ["/fake/repo"],
      spawnFn,
      watchFn,
      detectLiveRunFn,
      logger,
      debounceMs: 50,
      pollIntervalMs: 100,
      ...overrides
    });
  }

  it("spawns the entry script as a child and starts watching on start()", () => {
    const supervisor = make();

    supervisor.start();

    expect(spawnFn).toHaveBeenCalledWith(process.execPath, ["/fake/index.js"], expect.objectContaining({ stdio: "inherit" }));
    expect(watchFn).toHaveBeenCalledWith(["/fake/src"]);
    expect(supervisor.child).toBeTruthy();
  });

  it("restarts the child immediately on a file change when no run is active", async () => {
    detectLiveRunFn.mockResolvedValue({ live: false });
    const supervisor = make();
    supervisor.start();
    const firstChild = supervisor.child;

    watcher.emit("all", "change", "/fake/src/foo.js");
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();

    expect(detectLiveRunFn).toHaveBeenCalledWith({ runsDir: "/fake/tasks/.runs", boardDirs: ["/fake/repo"] });
    expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(supervisor.child).not.toBe(firstChild);
  });

  it("defers the restart while a run is active, and never touches the child", async () => {
    detectLiveRunFn.mockResolvedValue({ live: true });
    const supervisor = make();
    supervisor.start();
    const firstChild = supervisor.child;

    watcher.emit("all", "change", "/fake/src/foo.js");
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();

    expect(firstChild.kill).not.toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("file change detected while a card run is active -- restart deferred until idle")
    );
  });

  it("restarts once the deferred run finishes, with no further file change needed", async () => {
    detectLiveRunFn.mockResolvedValue({ live: true });
    const supervisor = make();
    supervisor.start();
    const firstChild = supervisor.child;

    watcher.emit("all", "change", "/fake/src/foo.js");
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();
    expect(spawnFn).toHaveBeenCalledTimes(1);

    detectLiveRunFn.mockResolvedValue({ live: false });
    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();

    expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("deferred restart: active run finished"));
  });

  it("keeps polling (and never restarting) across multiple poll ticks while the run stays active", async () => {
    detectLiveRunFn.mockResolvedValue({ live: true });
    const supervisor = make();
    supervisor.start();

    watcher.emit("all", "change", "/fake/src/foo.js");
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(detectLiveRunFn).toHaveBeenCalledTimes(3);
  });

  it("debounces rapid consecutive changes into a single evaluation", async () => {
    detectLiveRunFn.mockResolvedValue({ live: false });
    const supervisor = make();
    supervisor.start();

    watcher.emit("all", "change", "/fake/src/a.js");
    await vi.advanceTimersByTimeAsync(10);
    watcher.emit("all", "change", "/fake/src/b.js");
    await vi.advanceTimersByTimeAsync(10);
    watcher.emit("all", "change", "/fake/src/c.js");
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();

    expect(detectLiveRunFn).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it("stop() kills the child, closes the watcher, and cancels a pending deferred restart", async () => {
    detectLiveRunFn.mockResolvedValue({ live: true });
    const supervisor = make();
    supervisor.start();
    const firstChild = supervisor.child;

    watcher.emit("all", "change", "/fake/src/foo.js");
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();

    detectLiveRunFn.mockResolvedValue({ live: false });
    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});
