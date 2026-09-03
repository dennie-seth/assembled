import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeRunState,
  readRunState,
  clearRunState,
  isPidAlive,
  isRunLive,
  isRunWedged,
  killPidGroup,
  DEFAULT_HEARTBEAT_STALE_MS,
  DEFAULT_WEDGED_STALE_MS,
  DEFAULT_KILL_ESCALATION_MS
} from "../../src/runner/runState.js";

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "runstate-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("writeRunState / readRunState / clearRunState", () => {
  it("round-trips pid and runLogPath", async () => {
    await writeRunState({ runsDir: tmpDir, taskId: "T-0001", pid: 4242, runLogPath: "/x/T-0001.jsonl" });

    const state = await readRunState({ runsDir: tmpDir, taskId: "T-0001" });

    expect(state.pid).toBe(4242);
    expect(state.runLogPath).toBe("/x/T-0001.jsonl");
    expect(typeof state.updatedAt).toBe("string");
  });

  it("returns null when no runstate file exists", async () => {
    const state = await readRunState({ runsDir: tmpDir, taskId: "T-missing" });
    expect(state).toBeNull();
  });

  it("returns null instead of throwing when runsDir itself doesn't exist", async () => {
    const state = await readRunState({ runsDir: path.join(tmpDir, "nope"), taskId: "T-0001" });
    expect(state).toBeNull();
  });

  it("never throws when writing to an unwritable path", async () => {
    await expect(
      writeRunState({ runsDir: "/root/unwritable-by-this-test/nope", taskId: "T-0001", pid: 1, runLogPath: "x" })
    ).resolves.toBeUndefined();
  });

  it("clearRunState removes the file so a later read returns null", async () => {
    await writeRunState({ runsDir: tmpDir, taskId: "T-0002", pid: 1, runLogPath: "x" });
    await clearRunState({ runsDir: tmpDir, taskId: "T-0002" });

    expect(await readRunState({ runsDir: tmpDir, taskId: "T-0002" })).toBeNull();
  });

  it("clearRunState does not throw when the file is already gone", async () => {
    await expect(clearRunState({ runsDir: tmpDir, taskId: "T-never-existed" })).resolves.toBeUndefined();
  });
});

describe("isPidAlive", () => {
  it("is true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("is false for a pid that almost certainly doesn't exist", () => {
    expect(isPidAlive(2_000_000_000)).toBe(false);
  });

  it.each([undefined, null, "4242", -1, 0, 1.5])("is false for non-pid value %p", (value) => {
    expect(isPidAlive(value)).toBe(false);
  });
});

describe("isRunLive", () => {
  it("is false when there is no recorded state at all", async () => {
    expect(await isRunLive({ state: null })).toBe(false);
  });

  it("is true when the recorded pid is alive, regardless of heartbeat", async () => {
    const live = await isRunLive({
      state: { pid: 4242, runLogPath: "/x", updatedAt: new Date(0).toISOString() },
      now: Date.now(),
      isPidAliveFn: (pid) => pid === 4242
    });
    expect(live).toBe(true);
  });

  it("is false when the recorded pid is dead and the run log is also stale -- genuinely dead, not just inconclusive", async () => {
    const now = Date.now();
    const live = await isRunLive({
      state: { pid: 4242, runLogPath: "/x", updatedAt: new Date(now - 200_000).toISOString() },
      now,
      isPidAliveFn: () => false,
      statFn: async () => ({ mtimeMs: now - 200_000 })
    });
    expect(live).toBe(false);
  });

  // T-0289: isPidAliveFn's own contract (see isPidAlive's docstring) treats any process.kill(2)
  // failure other than EPERM as "dead" -- normally correct, but a false negative there (an
  // unexpected errno, a transient fork/exec-handoff hiccup) must not be trusted as the sole
  // signal a reap decision is built on. T-0276/T-0287 were both reaped with a recorded pid a
  // human confirmed was alive at the time, and a run log that had just been written to -- the
  // pid check saying "not alive" was wrong, and nothing corroborated it before reaping. A pid
  // check that reports not-alive is now corroborated against the run log's mtime, exactly like
  // the no-pid fallback below: a log actively being appended to is direct evidence of life the
  // pid check's own false negative shouldn't override.
  it("is true when the pid check reports not-alive but the run log was written to seconds ago (T-0287 shape: corroborating evidence overrides a false-negative pid check)", async () => {
    const now = Date.now();
    const live = await isRunLive({
      state: { pid: 246322, runLogPath: "/x", updatedAt: new Date(now - 2 * 60 * 60_000).toISOString() },
      now,
      heartbeatStaleMs: DEFAULT_HEARTBEAT_STALE_MS,
      isPidAliveFn: () => false,
      statFn: async () => ({ mtimeMs: now - 1000 })
    });
    expect(live).toBe(true);
  });

  it("is false when the pid check reports not-alive and the run log has also gone stale -- no corroborating evidence, genuinely dead", async () => {
    const now = Date.now();
    const live = await isRunLive({
      state: { pid: 4242, runLogPath: "/x", updatedAt: new Date(now - 200_000).toISOString() },
      now,
      heartbeatStaleMs: DEFAULT_HEARTBEAT_STALE_MS,
      isPidAliveFn: () => false,
      statFn: async () => ({ mtimeMs: now - 200_000 })
    });
    expect(live).toBe(false);
  });

  it("is false when the pid check reports not-alive and the run log can't be stat'd at all -- no corroborating evidence", async () => {
    const live = await isRunLive({
      state: { pid: 4242, runLogPath: "/does/not/exist", updatedAt: new Date().toISOString() },
      isPidAliveFn: () => false,
      statFn: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
    });
    expect(live).toBe(false);
  });

  it("falls back to a fresh run-log heartbeat when no pid was recorded", async () => {
    const now = Date.now();
    const live = await isRunLive({
      state: { runLogPath: "/x", updatedAt: new Date(now).toISOString() },
      now,
      heartbeatStaleMs: DEFAULT_HEARTBEAT_STALE_MS,
      statFn: async () => ({ mtimeMs: now - 1000 })
    });
    expect(live).toBe(true);
  });

  it("treats a stale run-log heartbeat (no pid) as dead", async () => {
    const now = Date.now();
    const live = await isRunLive({
      state: { runLogPath: "/x", updatedAt: new Date(now - 200_000).toISOString() },
      now,
      heartbeatStaleMs: DEFAULT_HEARTBEAT_STALE_MS,
      statFn: async () => ({ mtimeMs: now - 200_000 })
    });
    expect(live).toBe(false);
  });

  it("is false when no pid and the run log can't be stat'd", async () => {
    const live = await isRunLive({
      state: { runLogPath: "/does/not/exist", updatedAt: new Date().toISOString() },
      statFn: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
    });
    expect(live).toBe(false);
  });
});

describe("isRunWedged", () => {
  it("is false when there is no recorded state", async () => {
    expect(await isRunWedged({ state: null })).toBe(false);
  });

  it("is false when the state has no runLogPath to check", async () => {
    expect(await isRunWedged({ state: { pid: 4242 } })).toBe(false);
  });

  it("is true when the pid is alive but the run log hasn't grown within the stale window", async () => {
    const now = Date.now();
    const wedged = await isRunWedged({
      state: { pid: 4242, runLogPath: "/x/T-0001.jsonl" },
      now,
      wedgedStaleMs: 1000,
      statFn: async () => ({ mtimeMs: now - 5000 })
    });
    expect(wedged).toBe(true);
  });

  it("is false when the run log is still growing within the stale window", async () => {
    const now = Date.now();
    const wedged = await isRunWedged({
      state: { pid: 4242, runLogPath: "/x/T-0001.jsonl" },
      now,
      wedgedStaleMs: 1000,
      statFn: async () => ({ mtimeMs: now - 100 })
    });
    expect(wedged).toBe(false);
  });

  it("defaults wedgedStaleMs to DEFAULT_WEDGED_STALE_MS when not provided", async () => {
    const now = Date.now();
    const wedged = await isRunWedged({
      state: { pid: 4242, runLogPath: "/x/T-0001.jsonl" },
      now,
      statFn: async () => ({ mtimeMs: now - (DEFAULT_WEDGED_STALE_MS + 1000) })
    });
    expect(wedged).toBe(true);
  });

  it("is false (never throws) when the run log can't be stat'd", async () => {
    const wedged = await isRunWedged({
      state: { pid: 4242, runLogPath: "/does/not/exist" },
      wedgedStaleMs: 1000,
      statFn: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
    });
    expect(wedged).toBe(false);
  });
});

describe("killPidGroup", () => {
  it("does nothing when pid is not a number", async () => {
    const killFn = vi.fn();
    await killPidGroup({ pid: undefined, killFn });
    expect(killFn).not.toHaveBeenCalled();
  });

  it("sends SIGTERM to the negative pid (process group) first", async () => {
    const killFn = vi.fn();
    await killPidGroup({ pid: 4242, killFn, isPidAliveFn: () => false, delayFn: async () => {} });
    expect(killFn).toHaveBeenCalledWith(-4242, "SIGTERM");
  });

  it("falls back to a bare pid signal when the process-group kill throws (not a group leader)", async () => {
    const killFn = vi.fn((pid) => {
      if (pid < 0) throw new Error("ESRCH");
    });
    await killPidGroup({ pid: 4242, killFn, isPidAliveFn: () => false, delayFn: async () => {} });
    expect(killFn).toHaveBeenCalledWith(-4242, "SIGTERM");
    expect(killFn).toHaveBeenCalledWith(4242, "SIGTERM");
  });

  it("escalates to SIGKILL after escalationMs when the process is still alive", async () => {
    const killFn = vi.fn();
    const isPidAliveFn = vi.fn(() => true);
    const delayFn = vi.fn(async () => {});

    await killPidGroup({ pid: 4242, killFn, isPidAliveFn, delayFn, escalationMs: DEFAULT_KILL_ESCALATION_MS });

    expect(delayFn).toHaveBeenCalledWith(DEFAULT_KILL_ESCALATION_MS);
    expect(killFn).toHaveBeenCalledWith(-4242, "SIGTERM");
    expect(killFn).toHaveBeenCalledWith(-4242, "SIGKILL");
  });

  it("does not escalate when the process already exited after SIGTERM", async () => {
    const killFn = vi.fn();
    const isPidAliveFn = vi.fn(() => false);
    const delayFn = vi.fn(async () => {});

    await killPidGroup({ pid: 4242, killFn, isPidAliveFn, delayFn });

    expect(killFn).toHaveBeenCalledTimes(1);
    expect(killFn).toHaveBeenCalledWith(-4242, "SIGTERM");
  });
});
