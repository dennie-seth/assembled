import { describe, it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchedLivenessPaths, probeLivenessMtime, DEFAULT_LIVENESS_PROBE_INTERVAL_MS } from "../../src/runner/filesystemLiveness.js";

describe("watchedLivenessPaths", () => {
  it("returns the worktree root and the run log path, in that order", () => {
    expect(watchedLivenessPaths({ worktreeDir: "/repo/worktrees/T-0001", runLogPath: "/repo/tasks/.runs/T-0001-x.jsonl" })).toEqual([
      "/repo/worktrees/T-0001",
      "/repo/tasks/.runs/T-0001-x.jsonl"
    ]);
  });

  it("drops a missing runLogPath rather than passing a falsy entry through to the prober", () => {
    expect(watchedLivenessPaths({ worktreeDir: "/repo/worktrees/T-0001", runLogPath: undefined })).toEqual([
      "/repo/worktrees/T-0001"
    ]);
  });

  it("drops a missing worktreeDir too, so a caller with neither gets an empty (not crashing) watch set", () => {
    expect(watchedLivenessPaths({ worktreeDir: null, runLogPath: null })).toEqual([]);
  });
});

describe("probeLivenessMtime", () => {
  it("returns the freshest {path, mtimeMs} across the watched set when the worktree is newer", async () => {
    const statFn = vi.fn(async (target) => {
      if (target === "/repo/worktrees/T-0001") return { mtimeMs: 2000 };
      if (target === "/repo/tasks/.runs/T-0001-x.jsonl") return { mtimeMs: 1000 };
      throw new Error(`unexpected stat target: ${target}`);
    });

    const result = await probeLivenessMtime({
      worktreeDir: "/repo/worktrees/T-0001",
      runLogPath: "/repo/tasks/.runs/T-0001-x.jsonl",
      statFn
    });

    expect(result).toEqual({ path: "/repo/worktrees/T-0001", mtimeMs: 2000 });
  });

  it("returns the freshest {path, mtimeMs} across the watched set when the run log is newer", async () => {
    const statFn = vi.fn(async (target) => {
      if (target === "/repo/worktrees/T-0001") return { mtimeMs: 1000 };
      if (target === "/repo/tasks/.runs/T-0001-x.jsonl") return { mtimeMs: 5000 };
      throw new Error(`unexpected stat target: ${target}`);
    });

    const result = await probeLivenessMtime({
      worktreeDir: "/repo/worktrees/T-0001",
      runLogPath: "/repo/tasks/.runs/T-0001-x.jsonl",
      statFn
    });

    expect(result).toEqual({ path: "/repo/tasks/.runs/T-0001-x.jsonl", mtimeMs: 5000 });
  });

  it("degrades to null (no evidence) rather than throwing when every watched path is missing/unreadable", async () => {
    const statFn = vi.fn(async () => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    });

    await expect(
      probeLivenessMtime({ worktreeDir: "/repo/worktrees/T-0001", runLogPath: "/repo/tasks/.runs/T-0001-x.jsonl", statFn })
    ).resolves.toBeNull();
  });

  it("skips one unreadable path but still reports the other -- one bad stat doesn't blank the whole probe", async () => {
    const statFn = vi.fn(async (target) => {
      if (target === "/repo/worktrees/T-0001") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { mtimeMs: 42 };
    });

    const result = await probeLivenessMtime({
      worktreeDir: "/repo/worktrees/T-0001",
      runLogPath: "/repo/tasks/.runs/T-0001-x.jsonl",
      statFn
    });

    expect(result).toEqual({ path: "/repo/tasks/.runs/T-0001-x.jsonl", mtimeMs: 42 });
  });

  it("returns null when there is nothing in the watched set at all (no worktreeDir, no runLogPath)", async () => {
    const statFn = vi.fn(async () => ({ mtimeMs: 1 }));
    const result = await probeLivenessMtime({ worktreeDir: null, runLogPath: null, statFn });
    expect(result).toBeNull();
    expect(statFn).not.toHaveBeenCalled();
  });

  it("never rejects even when statFn itself throws synchronously rather than returning a rejected promise", async () => {
    const statFn = vi.fn(() => {
      throw new Error("boom");
    });
    await expect(probeLivenessMtime({ worktreeDir: "/nope", runLogPath: null, statFn })).resolves.toBeNull();
  });

  it("defaults to the real fs.stat and reports a just-written file's mtime", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assembled-liveness-"));
    const filePath = path.join(dir, "checkpoint.bin");
    try {
      await fs.writeFile(filePath, "progress");
      const result = await probeLivenessMtime({ worktreeDir: filePath, runLogPath: null });
      expect(result).not.toBeNull();
      expect(result.path).toBe(filePath);
      expect(result.mtimeMs).toBeGreaterThan(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("defaults to the real fs.stat and degrades to null for a path that does not exist, without throwing", async () => {
    await expect(
      probeLivenessMtime({ worktreeDir: "/definitely/does/not/exist/T-0308", runLogPath: null })
    ).resolves.toBeNull();
  });
});

describe("DEFAULT_LIVENESS_PROBE_INTERVAL_MS", () => {
  it("is well under the default inactivity budget, so it gets several chances per window", () => {
    expect(DEFAULT_LIVENESS_PROBE_INTERVAL_MS).toBeGreaterThan(0);
    expect(DEFAULT_LIVENESS_PROBE_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });
});
