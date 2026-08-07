import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRestartCoordinator, restartBoardService, autoRestartOnPullFromEnv } from "../../src/runner/serviceRestart.js";

function makeLogger() {
  return { log: vi.fn(), error: vi.fn() };
}

describe("restartBoardService", () => {
  it("spawns systemctl --user restart in detached form and unrefs it", () => {
    const child = { unref: vi.fn() };
    const spawnFn = vi.fn(() => child);

    restartBoardService({ spawnFn });

    expect(spawnFn).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "restart", "assembled-board.service"],
      expect.objectContaining({ detached: true, stdio: "ignore" })
    );
    expect(child.unref).toHaveBeenCalledTimes(1);
  });
});

describe("autoRestartOnPullFromEnv", () => {
  const original = process.env.AUTO_RESTART_ON_PULL;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AUTO_RESTART_ON_PULL;
    } else {
      process.env.AUTO_RESTART_ON_PULL = original;
    }
  });

  it("defaults to true when unset", () => {
    delete process.env.AUTO_RESTART_ON_PULL;
    expect(autoRestartOnPullFromEnv()).toBe(true);
  });

  it.each(["0", "false", "off", "no", "FALSE", "Off"])("is false when set to %s", (value) => {
    process.env.AUTO_RESTART_ON_PULL = value;
    expect(autoRestartOnPullFromEnv()).toBe(false);
  });
});

describe("createRestartCoordinator", () => {
  let restart;
  let logger;

  beforeEach(() => {
    restart = vi.fn();
    logger = makeLogger();
  });

  it("restarts immediately when a pull advances code and no run is active", () => {
    const coordinator = createRestartCoordinator({ restart, enabled: true, logger });

    coordinator.notifyPulled({ hasActiveRuns: false });

    expect(restart).toHaveBeenCalledTimes(1);
    expect(coordinator.pending).toBe(false);
  });

  it("never restarts while a run is in-progress, and sets a pending flag instead", () => {
    const coordinator = createRestartCoordinator({ restart, enabled: true, logger });

    coordinator.notifyPulled({ hasActiveRuns: true });

    expect(restart).not.toHaveBeenCalled();
    expect(coordinator.pending).toBe(true);
  });

  it("performs the deferred restart once the orchestrator reports idle", () => {
    const coordinator = createRestartCoordinator({ restart, enabled: true, logger });

    coordinator.notifyPulled({ hasActiveRuns: true });
    expect(restart).not.toHaveBeenCalled();

    coordinator.notifyIdle();

    expect(restart).toHaveBeenCalledTimes(1);
    expect(coordinator.pending).toBe(false);
  });

  it("does nothing on idle when no restart is pending", () => {
    const coordinator = createRestartCoordinator({ restart, enabled: true, logger });

    coordinator.notifyIdle();

    expect(restart).not.toHaveBeenCalled();
  });

  it("never restarts, immediately or deferred, when disabled", () => {
    const coordinator = createRestartCoordinator({ restart, enabled: false, logger });

    coordinator.notifyPulled({ hasActiveRuns: false });
    expect(restart).not.toHaveBeenCalled();

    coordinator.notifyPulled({ hasActiveRuns: true });
    coordinator.notifyIdle();
    expect(restart).not.toHaveBeenCalled();
    expect(coordinator.pending).toBe(false);
  });

  it("exposes its enabled flag from the constructor option", () => {
    expect(createRestartCoordinator({ restart, enabled: true, logger }).enabled).toBe(true);
    expect(createRestartCoordinator({ restart, enabled: false, logger }).enabled).toBe(false);
  });
});
