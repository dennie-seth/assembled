import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";

/**
 * T-0385: `dev:server` now runs `exec node src/server/watch.js` instead of
 * `exec node --watch src/server/index.js` (see watchSupervisor.test.js for the guard logic
 * itself). This pins the CLI wiring: watch.js resolves entryPath/watchPaths/runsDir/boardDirs
 * from the real repo layout (with env overrides for testability -- see devWatchGuard.test.js
 * for the real end-to-end process spawn), starts the supervisor, and forwards SIGTERM/SIGINT to
 * a clean supervisor.stop() + process.exit(0), mirroring index.js's own shutdown handling.
 */

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

describe("board watch entry point", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("../../src/server/watchSupervisor.js");
    resetEnv();
  });

  it("starts the watch supervisor and installs SIGTERM/SIGINT handlers that stop it and exit", async () => {
    const stopMock = vi.fn(async () => {});
    const startMock = vi.fn();
    vi.doMock("../../src/server/watchSupervisor.js", () => ({
      createWatchSupervisor: vi.fn(() => ({ start: startMock, stop: stopMock }))
    }));

    const onSpy = vi.spyOn(process, "on");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await import("../../src/server/watch.js");

    expect(startMock).toHaveBeenCalledTimes(1);

    const sigtermHandler = onSpy.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
    const sigintHandler = onSpy.mock.calls.find(([event]) => event === "SIGINT")?.[1];
    expect(typeof sigtermHandler).toBe("function");
    expect(typeof sigintHandler).toBe("function");

    await sigtermHandler();

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("still exits after a rejecting supervisor.stop() during shutdown", async () => {
    const stopMock = vi.fn(async () => {
      throw new Error("simulated stop failure");
    });
    vi.doMock("../../src/server/watchSupervisor.js", () => ({
      createWatchSupervisor: vi.fn(() => ({ start: vi.fn(), stop: stopMock }))
    }));

    const onSpy = vi.spyOn(process, "on");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await import("../../src/server/watch.js");

    const sigintHandler = onSpy.mock.calls.find(([event]) => event === "SIGINT")?.[1];
    await expect(sigintHandler()).resolves.toBeUndefined();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("resolves entryPath/watchPaths/runsDir/boardDirs from the real repo layout by default", async () => {
    const createWatchSupervisorMock = vi.fn(() => ({ start: vi.fn(), stop: vi.fn(async () => {}) }));
    vi.doMock("../../src/server/watchSupervisor.js", () => ({
      createWatchSupervisor: createWatchSupervisorMock
    }));
    vi.spyOn(process, "on").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await import("../../src/server/watch.js");

    const call = createWatchSupervisorMock.mock.calls[0][0];
    expect(call.entryPath.endsWith(path.join("src", "server", "index.js"))).toBe(true);
    expect(call.watchPaths).toHaveLength(1);
    expect(call.watchPaths[0].endsWith(path.join("board", "src"))).toBe(true);
    expect(call.runsDir.endsWith(path.join("tasks", ".runs"))).toBe(true);
    expect(call.boardDirs).toHaveLength(1);
  });

  it("honors BOARD_TASKS_DIR, BOARD_WATCH_PATHS, and BOARD_REPO_ROOT overrides", async () => {
    process.env.BOARD_TASKS_DIR = "/tmp/fake-tasks";
    process.env.BOARD_WATCH_PATHS = "/tmp/fake-watch-a,/tmp/fake-watch-b";
    process.env.BOARD_REPO_ROOT = "/tmp/fake-repo";

    const createWatchSupervisorMock = vi.fn(() => ({ start: vi.fn(), stop: vi.fn(async () => {}) }));
    vi.doMock("../../src/server/watchSupervisor.js", () => ({
      createWatchSupervisor: createWatchSupervisorMock
    }));
    vi.spyOn(process, "on").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await import("../../src/server/watch.js");

    const call = createWatchSupervisorMock.mock.calls[0][0];
    expect(call.watchPaths).toEqual(["/tmp/fake-watch-a", "/tmp/fake-watch-b"]);
    expect(call.runsDir).toBe(path.join("/tmp/fake-tasks", ".runs"));
    expect(call.boardDirs).toEqual(["/tmp/fake-repo"]);
  });
});
