import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeRunState,
  readRunState,
  clearRunState,
  isPidAlive,
  isRunLive,
  DEFAULT_HEARTBEAT_STALE_MS
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

  it("is false when the recorded pid is dead, even with a fresh heartbeat", async () => {
    const live = await isRunLive({
      state: { pid: 4242, runLogPath: "/x", updatedAt: new Date().toISOString() },
      now: Date.now(),
      isPidAliveFn: () => false,
      statFn: async () => ({ mtimeMs: Date.now() })
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
