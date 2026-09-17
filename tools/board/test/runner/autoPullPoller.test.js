import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAutoPullPoller,
  boardAutopullEnabledFromEnv,
  autoPullIntervalMsFromEnv,
  DEFAULT_AUTOPULL_INTERVAL_MS
} from "../../src/runner/autoPullPoller.js";

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeGit({ behind = false, pullResult = { advanced: false, before: "aaa", after: "aaa" } } = {}) {
  return {
    isBehindOrigin: vi.fn().mockResolvedValue(behind),
    pullDevelop: vi.fn().mockResolvedValue(pullResult)
  };
}

function makeOrchestrator(hasActiveRuns) {
  return { hasActiveRuns: vi.fn(() => hasActiveRuns) };
}

function makeRestartCoordinator() {
  return { notifyPulled: vi.fn(), notifyIdle: vi.fn() };
}

describe("boardAutopullEnabledFromEnv", () => {
  const original = process.env.BOARD_AUTOPULL;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.BOARD_AUTOPULL;
    } else {
      process.env.BOARD_AUTOPULL = original;
    }
  });

  it("defaults to true when unset", () => {
    delete process.env.BOARD_AUTOPULL;
    expect(boardAutopullEnabledFromEnv()).toBe(true);
  });

  it.each(["0", "false", "off", "no", "FALSE", "Off"])("is false when set to %s", (value) => {
    process.env.BOARD_AUTOPULL = value;
    expect(boardAutopullEnabledFromEnv()).toBe(false);
  });
});

describe("autoPullIntervalMsFromEnv", () => {
  const original = process.env.BOARD_AUTOPULL_INTERVAL_MS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.BOARD_AUTOPULL_INTERVAL_MS;
    } else {
      process.env.BOARD_AUTOPULL_INTERVAL_MS = original;
    }
  });

  it("defaults to 5 minutes when unset", () => {
    delete process.env.BOARD_AUTOPULL_INTERVAL_MS;
    expect(autoPullIntervalMsFromEnv()).toBe(DEFAULT_AUTOPULL_INTERVAL_MS);
    expect(DEFAULT_AUTOPULL_INTERVAL_MS).toBe(5 * 60_000);
  });

  it("preserves an explicit 0 as the disable sentinel", () => {
    process.env.BOARD_AUTOPULL_INTERVAL_MS = "0";
    expect(autoPullIntervalMsFromEnv()).toBe(0);
  });

  it("uses a valid positive override", () => {
    process.env.BOARD_AUTOPULL_INTERVAL_MS = "60000";
    expect(autoPullIntervalMsFromEnv()).toBe(60000);
  });

  it("falls back to the default on garbage input", () => {
    process.env.BOARD_AUTOPULL_INTERVAL_MS = "not-a-number";
    expect(autoPullIntervalMsFromEnv()).toBe(DEFAULT_AUTOPULL_INTERVAL_MS);
  });

  it("falls back to the default on a negative value", () => {
    process.env.BOARD_AUTOPULL_INTERVAL_MS = "-1000";
    expect(autoPullIntervalMsFromEnv()).toBe(DEFAULT_AUTOPULL_INTERVAL_MS);
  });
});

describe("createAutoPullPoller — tick", () => {
  let logger;

  beforeEach(() => {
    logger = makeLogger();
  });

  it("(a) pulls and schedules a restart when origin is ahead and the board is idle", async () => {
    const git = makeGit({ behind: true, pullResult: { advanced: true, before: "aaa", after: "bbb" } });
    const orchestrator = makeOrchestrator(false);
    const restartCoordinator = makeRestartCoordinator();
    const poller = createAutoPullPoller({
      repoRoot: "/fake/repo",
      branch: "develop",
      orchestrator,
      restartCoordinator,
      enabled: true,
      intervalMs: 1000,
      git,
      logger
    });

    const result = await poller.tick();

    expect(git.isBehindOrigin).toHaveBeenCalledWith({ repoRoot: "/fake/repo", branch: "develop" });
    expect(git.pullDevelop).toHaveBeenCalledWith({ repoRoot: "/fake/repo", branch: "develop" });
    expect(restartCoordinator.notifyPulled).toHaveBeenCalledWith({ hasActiveRuns: false });
    expect(result).toMatchObject({ advanced: true });
  });

  it("(b) skips the entire tick -- no fetch, no pull, no restart -- when a card run is live", async () => {
    const git = makeGit({ behind: true, pullResult: { advanced: true, before: "aaa", after: "bbb" } });
    const orchestrator = makeOrchestrator(true);
    const restartCoordinator = makeRestartCoordinator();
    const poller = createAutoPullPoller({
      repoRoot: "/fake/repo",
      orchestrator,
      restartCoordinator,
      enabled: true,
      intervalMs: 1000,
      git,
      logger
    });

    const result = await poller.tick();

    expect(git.isBehindOrigin).not.toHaveBeenCalled();
    expect(git.pullDevelop).not.toHaveBeenCalled();
    expect(restartCoordinator.notifyPulled).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("(c) no-ops quietly when already up to date (not behind)", async () => {
    const git = makeGit({ behind: false });
    const orchestrator = makeOrchestrator(false);
    const restartCoordinator = makeRestartCoordinator();
    const poller = createAutoPullPoller({
      repoRoot: "/fake/repo",
      orchestrator,
      restartCoordinator,
      enabled: true,
      intervalMs: 1000,
      git,
      logger
    });

    const result = await poller.tick();

    expect(git.isBehindOrigin).toHaveBeenCalled();
    expect(git.pullDevelop).not.toHaveBeenCalled();
    expect(restartCoordinator.notifyPulled).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("does not notify the restart coordinator when the pull did not actually advance HEAD", async () => {
    const git = makeGit({ behind: true, pullResult: { advanced: false, before: "aaa", after: "aaa" } });
    const orchestrator = makeOrchestrator(false);
    const restartCoordinator = makeRestartCoordinator();
    const poller = createAutoPullPoller({
      repoRoot: "/fake/repo",
      orchestrator,
      restartCoordinator,
      enabled: true,
      intervalMs: 1000,
      git,
      logger
    });

    await poller.tick();

    expect(restartCoordinator.notifyPulled).not.toHaveBeenCalled();
  });

  it("defers the restart (hasActiveRuns: true) exactly like the Done path when a run started during the pull", async () => {
    const git = makeGit({ behind: true, pullResult: { advanced: true, before: "aaa", after: "bbb" } });
    let active = false;
    const orchestrator = { hasActiveRuns: vi.fn(() => active) };
    const restartCoordinator = makeRestartCoordinator();
    git.pullDevelop.mockImplementation(async () => {
      active = true;
      return { advanced: true, before: "aaa", after: "bbb" };
    });
    const poller = createAutoPullPoller({
      repoRoot: "/fake/repo",
      orchestrator,
      restartCoordinator,
      enabled: true,
      intervalMs: 1000,
      git,
      logger
    });

    await poller.tick();

    expect(restartCoordinator.notifyPulled).toHaveBeenCalledWith({ hasActiveRuns: true });
  });

  it("does not throw when no restartCoordinator is configured", async () => {
    const git = makeGit({ behind: true, pullResult: { advanced: true, before: "aaa", after: "bbb" } });
    const orchestrator = makeOrchestrator(false);
    const poller = createAutoPullPoller({
      repoRoot: "/fake/repo",
      orchestrator,
      enabled: true,
      intervalMs: 1000,
      git,
      logger
    });

    await expect(poller.tick()).resolves.toMatchObject({ advanced: true });
  });

  it("no-ops without touching git when no repoRoot is configured", async () => {
    const git = makeGit({ behind: true });
    const orchestrator = makeOrchestrator(false);
    const poller = createAutoPullPoller({ repoRoot: null, orchestrator, enabled: true, intervalMs: 1000, git, logger });

    const result = await poller.tick();

    expect(git.isBehindOrigin).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe("createAutoPullPoller — (d) disable flag / env knobs", () => {
  it("tick() is a no-op and never touches git when enabled: false", async () => {
    const git = makeGit({ behind: true });
    const orchestrator = makeOrchestrator(false);
    const poller = createAutoPullPoller({
      repoRoot: "/fake/repo",
      orchestrator,
      enabled: false,
      intervalMs: 1000,
      git,
      logger: makeLogger()
    });

    const result = await poller.tick();

    expect(git.isBehindOrigin).not.toHaveBeenCalled();
    expect(result).toBeNull();
    expect(poller.enabled).toBe(false);
  });

  it("tick() is a no-op when intervalMs is 0 (the disable sentinel), even if enabled: true", async () => {
    const git = makeGit({ behind: true });
    const orchestrator = makeOrchestrator(false);
    const poller = createAutoPullPoller({
      repoRoot: "/fake/repo",
      orchestrator,
      enabled: true,
      intervalMs: 0,
      git,
      logger: makeLogger()
    });

    const result = await poller.tick();

    expect(git.isBehindOrigin).not.toHaveBeenCalled();
    expect(result).toBeNull();
    expect(poller.enabled).toBe(false);
  });

  it("exposes enabled: true when both enabled and a positive intervalMs are set", () => {
    const poller = createAutoPullPoller({
      repoRoot: "/fake/repo",
      orchestrator: makeOrchestrator(false),
      enabled: true,
      intervalMs: 1000,
      git: makeGit(),
      logger: makeLogger()
    });
    expect(poller.enabled).toBe(true);
  });
});

describe("createAutoPullPoller — start/stop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks on the configured interval once started", async () => {
    const git = makeGit({ behind: true, pullResult: { advanced: true, before: "aaa", after: "bbb" } });
    const orchestrator = makeOrchestrator(false);
    const restartCoordinator = makeRestartCoordinator();
    const poller = createAutoPullPoller({
      repoRoot: "/fake/repo",
      orchestrator,
      restartCoordinator,
      enabled: true,
      intervalMs: 1000,
      git,
      logger: makeLogger()
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(git.pullDevelop).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("does not tick again after stop is called", async () => {
    const git = makeGit({ behind: true, pullResult: { advanced: true, before: "aaa", after: "bbb" } });
    const orchestrator = makeOrchestrator(false);
    const poller = createAutoPullPoller({
      repoRoot: "/fake/repo",
      orchestrator,
      enabled: true,
      intervalMs: 1000,
      git,
      logger: makeLogger()
    });

    poller.start();
    poller.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(git.pullDevelop).not.toHaveBeenCalled();
  });

  it("never starts the interval when disabled", async () => {
    const git = makeGit({ behind: true });
    const orchestrator = makeOrchestrator(false);
    const poller = createAutoPullPoller({
      repoRoot: "/fake/repo",
      orchestrator,
      enabled: false,
      intervalMs: 1000,
      git,
      logger: makeLogger()
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(5000);

    expect(git.isBehindOrigin).not.toHaveBeenCalled();
  });

  it("never starts the interval when intervalMs is 0", async () => {
    const git = makeGit({ behind: true });
    const orchestrator = makeOrchestrator(false);
    const poller = createAutoPullPoller({
      repoRoot: "/fake/repo",
      orchestrator,
      enabled: true,
      intervalMs: 0,
      git,
      logger: makeLogger()
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(git.isBehindOrigin).not.toHaveBeenCalled();
  });

  it("a failing tick is caught and logged, not thrown -- the interval survives", async () => {
    const git = makeGit({ behind: true });
    git.pullDevelop.mockRejectedValueOnce(new Error("network down"));
    const orchestrator = makeOrchestrator(false);
    const logger = makeLogger();
    const poller = createAutoPullPoller({
      repoRoot: "/fake/repo",
      orchestrator,
      enabled: true,
      intervalMs: 1000,
      git,
      logger
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(logger.error).toHaveBeenCalled();
    poller.stop();
  });
});
