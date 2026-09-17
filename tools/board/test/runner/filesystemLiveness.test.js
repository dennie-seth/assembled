import { describe, it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  watchedLivenessPaths,
  probeLivenessMtime,
  DEFAULT_LIVENESS_PROBE_INTERVAL_MS
} from "../../src/runner/filesystemLiveness.js";
import { DEFAULT_PRESERVED_ARTIFACT_PATHS } from "../../src/runner/artifactPreservation.js";

describe("watchedLivenessPaths", () => {
  it("returns the worktree root plus each output subpath as dirs, and the run log path separately as a file", () => {
    expect(
      watchedLivenessPaths({
        worktreeDir: "/repo/worktrees/T-0001",
        runLogPath: "/repo/tasks/.runs/T-0001-x.jsonl",
        outputSubpaths: ["assets/out", "assets/final/lora"]
      })
    ).toEqual({
      dirs: [
        "/repo/worktrees/T-0001",
        path.join("/repo/worktrees/T-0001", "assets/out"),
        path.join("/repo/worktrees/T-0001", "assets/final/lora")
      ],
      files: ["/repo/tasks/.runs/T-0001-x.jsonl"]
    });
  });

  it("defaults outputSubpaths to the artifact-preservation allowlist -- the same known output dirs a card's own GPU/generation work already lands in", () => {
    const result = watchedLivenessPaths({ worktreeDir: "/repo/worktrees/T-0001", runLogPath: null });
    expect(result.dirs).toEqual([
      "/repo/worktrees/T-0001",
      ...DEFAULT_PRESERVED_ARTIFACT_PATHS.map((sub) => path.join("/repo/worktrees/T-0001", sub))
    ]);
  });

  it("drops a missing runLogPath rather than passing a falsy entry through to the prober", () => {
    expect(
      watchedLivenessPaths({ worktreeDir: "/repo/worktrees/T-0001", runLogPath: undefined, outputSubpaths: [] })
    ).toEqual({ dirs: ["/repo/worktrees/T-0001"], files: [] });
  });

  it("drops a missing worktreeDir too -- no dirs at all, even with output subpaths configured, so a caller with neither gets an empty (not crashing) watch set", () => {
    expect(watchedLivenessPaths({ worktreeDir: null, runLogPath: null, outputSubpaths: ["assets/out"] })).toEqual({
      dirs: [],
      files: []
    });
  });
});

describe("probeLivenessMtime", () => {
  it("returns the freshest {path, mtimeMs} across the watched set when the worktree root is newer", async () => {
    const statFn = vi.fn(async (target) => {
      if (target === "/repo/worktrees/T-0001") return { mtimeMs: 2000 };
      if (target === "/repo/tasks/.runs/T-0001-x.jsonl") return { mtimeMs: 1000 };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = await probeLivenessMtime({
      worktreeDir: "/repo/worktrees/T-0001",
      runLogPath: "/repo/tasks/.runs/T-0001-x.jsonl",
      outputSubpaths: [],
      statFn
    });

    expect(result).toEqual({ path: "/repo/worktrees/T-0001", mtimeMs: 2000 });
  });

  it("returns the freshest {path, mtimeMs} across the watched set when the run log is newer", async () => {
    const statFn = vi.fn(async (target) => {
      if (target === "/repo/worktrees/T-0001") return { mtimeMs: 1000 };
      if (target === "/repo/tasks/.runs/T-0001-x.jsonl") return { mtimeMs: 5000 };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = await probeLivenessMtime({
      worktreeDir: "/repo/worktrees/T-0001",
      runLogPath: "/repo/tasks/.runs/T-0001-x.jsonl",
      outputSubpaths: [],
      statFn
    });

    expect(result).toEqual({ path: "/repo/tasks/.runs/T-0001-x.jsonl", mtimeMs: 5000 });
  });

  it("probes each output subpath one level deep via readdir+stat, so a file written INSIDE a subagent's output dir is visible -- not just direct children of the worktree root", async () => {
    const readdirFn = vi.fn(async (dir) => {
      if (dir === "/repo/worktrees/T-0001/assets/out") return ["a.png", "b.png"];
      if (dir === "/repo/worktrees/T-0001") return ["assets"];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const mtimes = {
      "/repo/worktrees/T-0001": 100,
      "/repo/worktrees/T-0001/assets/out": 100,
      "/repo/worktrees/T-0001/assets/out/a.png": 9000,
      "/repo/worktrees/T-0001/assets/out/b.png": 300
    };
    const statFn = vi.fn(async (target) => {
      if (target in mtimes) return { mtimeMs: mtimes[target] };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = await probeLivenessMtime({
      worktreeDir: "/repo/worktrees/T-0001",
      runLogPath: null,
      outputSubpaths: ["assets/out"],
      statFn,
      readdirFn
    });

    expect(result).toEqual({ path: "/repo/worktrees/T-0001/assets/out/a.png", mtimeMs: 9000 });
    // Bounded: readdir is only ever called on the watched dirs themselves, never on an entry
    // it just returned (that would be an unbounded recursive walk).
    expect(readdirFn).not.toHaveBeenCalledWith("/repo/worktrees/T-0001/assets/out/a.png");
  });

  it("degrades a missing/unreadable output subdirectory to no evidence from it, without throwing -- the 'output dir doesn't exist yet' edge case", async () => {
    const statFn = vi.fn(async (target) => {
      if (target === "/repo/worktrees/T-0001") return { mtimeMs: 42 };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const readdirFn = vi.fn(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = await probeLivenessMtime({
      worktreeDir: "/repo/worktrees/T-0001",
      runLogPath: null,
      outputSubpaths: ["assets/out"],
      statFn,
      readdirFn
    });

    expect(result).toEqual({ path: "/repo/worktrees/T-0001", mtimeMs: 42 });
  });

  it("degrades to null (no evidence) rather than throwing when every watched path is missing/unreadable", async () => {
    const statFn = vi.fn(async () => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    });
    const readdirFn = vi.fn(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    await expect(
      probeLivenessMtime({
        worktreeDir: "/repo/worktrees/T-0001",
        runLogPath: "/repo/tasks/.runs/T-0001-x.jsonl",
        outputSubpaths: [],
        statFn,
        readdirFn
      })
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
      outputSubpaths: [],
      statFn
    });

    expect(result).toEqual({ path: "/repo/tasks/.runs/T-0001-x.jsonl", mtimeMs: 42 });
  });

  it("returns null when there is nothing in the watched set at all (no worktreeDir, no runLogPath, no output subpaths)", async () => {
    const statFn = vi.fn(async () => ({ mtimeMs: 1 }));
    const result = await probeLivenessMtime({ worktreeDir: null, runLogPath: null, outputSubpaths: [], statFn });
    expect(result).toBeNull();
    expect(statFn).not.toHaveBeenCalled();
  });

  it("never rejects even when statFn itself throws synchronously rather than returning a rejected promise", async () => {
    const statFn = vi.fn(() => {
      throw new Error("boom");
    });
    const readdirFn = vi.fn(() => {
      throw new Error("boom");
    });
    await expect(
      probeLivenessMtime({ worktreeDir: "/nope", runLogPath: null, outputSubpaths: ["assets/out"], statFn, readdirFn })
    ).resolves.toBeNull();
  });

  it("never rejects even when readdirFn itself throws synchronously rather than returning a rejected promise", async () => {
    const statFn = vi.fn(async () => ({ mtimeMs: 1 }));
    const readdirFn = vi.fn(() => {
      throw new Error("boom");
    });
    await expect(
      probeLivenessMtime({ worktreeDir: "/repo/worktrees/T-0001", runLogPath: null, outputSubpaths: ["assets/out"], statFn, readdirFn })
    ).resolves.not.toBeNull();
  });

  it("defaults to the real fs.stat and reports a just-written file's mtime", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assembled-liveness-"));
    const filePath = path.join(dir, "checkpoint.bin");
    try {
      await fs.writeFile(filePath, "progress");
      const result = await probeLivenessMtime({ worktreeDir: filePath, runLogPath: null, outputSubpaths: [] });
      expect(result).not.toBeNull();
      expect(result.path).toBe(filePath);
      expect(result.mtimeMs).toBeGreaterThan(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("defaults to the real fs.stat and degrades to null for a path that does not exist, without throwing", async () => {
    await expect(
      probeLivenessMtime({ worktreeDir: "/definitely/does/not/exist/T-0308", runLogPath: null, outputSubpaths: [] })
    ).resolves.toBeNull();
  });

  it("real fs, directory-mtime semantics: detects a file written INSIDE a watched output subdirectory nested under the worktree root -- the exact shape a subagent's checkpoint write takes, and the case the reviewer found nothing in this suite exercised", async () => {
    const worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "assembled-liveness-worktree-"));
    try {
      const outputDir = path.join(worktreeDir, "assets", "out");
      await fs.mkdir(outputDir, { recursive: true });

      const before = await probeLivenessMtime({
        worktreeDir,
        runLogPath: null,
        outputSubpaths: ["assets/out"]
      });
      expect(before).not.toBeNull(); // the freshly-created (empty) output dir is itself evidence

      // Give the filesystem clock room to move forward measurably past the baseline.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const checkpointPath = path.join(outputDir, "checkpoint-1.safetensors");
      await fs.writeFile(checkpointPath, "progress");

      const after = await probeLivenessMtime({
        worktreeDir,
        runLogPath: null,
        outputSubpaths: ["assets/out"]
      });

      expect(after).not.toBeNull();
      // Either the written file's own mtime or the containing dir's (bumped by the create) is
      // an acceptable winner on a tie -- what matters is growth is detected at all, not which of
      // the two simultaneous timestamps the comparison happens to prefer.
      expect([checkpointPath, outputDir]).toContain(after.path);
      expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
    } finally {
      await fs.rm(worktreeDir, { recursive: true, force: true });
    }
  });

  it("real fs: a missing output subdirectory (not yet created by the agent) degrades to no evidence from it, not a crash", async () => {
    const worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "assembled-liveness-nodir-"));
    try {
      const result = await probeLivenessMtime({
        worktreeDir,
        runLogPath: null,
        outputSubpaths: ["assets/out"]
      });
      // Nothing written yet anywhere -- only the worktree root itself is evidence.
      expect(result).toEqual({ path: worktreeDir, mtimeMs: expect.any(Number) });
    } finally {
      await fs.rm(worktreeDir, { recursive: true, force: true });
    }
  });
});

describe("DEFAULT_LIVENESS_PROBE_INTERVAL_MS", () => {
  it("is well under the default inactivity budget, so it gets several chances per window", () => {
    expect(DEFAULT_LIVENESS_PROBE_INTERVAL_MS).toBeGreaterThan(0);
    expect(DEFAULT_LIVENESS_PROBE_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });
});
