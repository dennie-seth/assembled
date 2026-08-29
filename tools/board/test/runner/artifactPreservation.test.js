import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmTemp } from "../helpers/rmTemp.js";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import {
  ARTIFACT_CACHE_DIRNAME,
  DEFAULT_PRESERVED_ARTIFACT_PATHS,
  artifactCacheRootFor,
  artifactPreservationEnabledFromEnv,
  cardCacheDir,
  clearPreservedArtifacts,
  listPreservableFiles,
  preserveArtifacts,
  preservedArtifactPathsFromEnv,
  pruneArtifactCache,
  restoreArtifacts
} from "../../src/runner/artifactPreservation.js";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

async function writeFile(root, rel, contents) {
  const target = path.join(root, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, "utf8");
  return target;
}

async function readFile(root, rel) {
  return fs.readFile(path.join(root, rel), "utf8");
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

let tmpDir;
let worktreeDir;
let cacheRoot;

/**
 * A stand-in card worktree: a real git repo (the module shells out to `git ls-files`) with one
 * tracked file and a .gitignore mirroring the real repo's Python/Node noise rules.
 */
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-artifacts-"));
  worktreeDir = path.join(tmpDir, "worktrees", "T-0248");
  cacheRoot = artifactCacheRootFor({ worktreesDir: path.join(tmpDir, "worktrees") });

  await fs.mkdir(worktreeDir, { recursive: true });
  await git(["init", "-b", "develop"], worktreeDir);
  await git(["config", "user.email", "test@example.com"], worktreeDir);
  await git(["config", "user.name", "Test"], worktreeDir);
  await writeFile(
    worktreeDir,
    ".gitignore",
    "__pycache__/\n.pytest_cache/\nnode_modules\nbuild/\nassets/src/lora/refs/\nassets/final/lora/*-state/\n"
  );
  await writeFile(worktreeDir, "assets/src/lora/src/lora_train/train.py", "print('v1')\n");
  await git(["add", "-A"], worktreeDir);
  await git(["commit", "-m", "initial"], worktreeDir);
});

afterEach(async () => {
  await rmTemp(tmpDir);
});

describe("preservedArtifactPathsFromEnv", () => {
  it("defaults to the built-in allowlist, which covers LoRA checkpoints and generated asset output", () => {
    expect(preservedArtifactPathsFromEnv({})).toEqual([...DEFAULT_PRESERVED_ARTIFACT_PATHS]);
    expect(DEFAULT_PRESERVED_ARTIFACT_PATHS).toContain("assets/final/lora");
    expect(DEFAULT_PRESERVED_ARTIFACT_PATHS).toContain("assets/out");
  });

  it("adds env-configured paths to the defaults rather than replacing them", () => {
    expect(preservedArtifactPathsFromEnv({ BOARD_PRESERVED_ARTIFACT_PATHS: "assets/tmp, ./tools/cache/" })).toEqual([
      ...DEFAULT_PRESERVED_ARTIFACT_PATHS,
      "assets/tmp",
      "tools/cache"
    ]);
  });

  it("drops absolute paths and anything escaping the worktree", () => {
    const paths = preservedArtifactPathsFromEnv({
      BOARD_PRESERVED_ARTIFACT_PATHS: "/etc:../../secrets:assets/ok:a/../../b"
    });
    expect(paths).toEqual([...DEFAULT_PRESERVED_ARTIFACT_PATHS, "assets/ok"]);
  });
});

describe("artifactPreservationEnabledFromEnv", () => {
  it("is on by default and off only for the explicit disable values", () => {
    expect(artifactPreservationEnabledFromEnv({})).toBe(true);
    expect(artifactPreservationEnabledFromEnv({ BOARD_PRESERVE_ARTIFACTS: "1" })).toBe(true);
    expect(artifactPreservationEnabledFromEnv({ BOARD_PRESERVE_ARTIFACTS: "OFF" })).toBe(false);
    expect(artifactPreservationEnabledFromEnv({ BOARD_PRESERVE_ARTIFACTS: "false" })).toBe(false);
  });
});

describe("cardCacheDir", () => {
  it("rejects a card id that is not a plain path segment", () => {
    expect(() => cardCacheDir({ cacheRoot, cardId: "../escape" })).toThrow(/Unsafe artifact-cache key/);
    expect(() => cardCacheDir({ cacheRoot, cardId: "" })).toThrow(/Unsafe artifact-cache key/);
    expect(cardCacheDir({ cacheRoot, cardId: "T-0248" })).toBe(path.join(cacheRoot, "T-0248"));
  });
});

describe("listPreservableFiles", () => {
  it("collects untracked and ignored files under the allowlist, and nothing outside it", async () => {
    // The real T-0248 shape: checkpoints are plain untracked, the corpus is gitignored.
    await writeFile(worktreeDir, "assets/final/lora/v2-step00000004-state/optimizer.bin", "state");
    await writeFile(worktreeDir, "assets/final/lora/v2-step00000004.safetensors", "weights");
    await writeFile(worktreeDir, "assets/src/lora/refs/ref-001.png", "corpus");
    // Junk that must never be dragged along.
    await writeFile(worktreeDir, "assets/src/lora/src/lora_train/__pycache__/train.pyc", "junk");
    await writeFile(worktreeDir, "build/main.o", "junk");
    await writeFile(worktreeDir, "notes-scratch.md", "junk");

    const files = await listPreservableFiles({
      worktreeDir,
      artifactPaths: [...DEFAULT_PRESERVED_ARTIFACT_PATHS]
    });

    expect(files).toEqual([
      "assets/final/lora/v2-step00000004-state/optimizer.bin",
      "assets/final/lora/v2-step00000004.safetensors",
      "assets/src/lora/refs/ref-001.png"
    ]);
  });

  it("still collects the sd-scripts state dirs now that .gitignore excludes them from commits", async () => {
    // The repo gitignores `assets/final/lora/*-state/` (resumable intermediate trainer state,
    // never a deliverable, and gigabytes per run). Preservation must not key off "untracked" --
    // being ignored is exactly why these need rescuing on disk instead of in git.
    await writeFile(worktreeDir, "assets/final/lora/v2-step00000004-state/optimizer.bin", "state");
    await writeFile(worktreeDir, "assets/final/lora/v2-step00000004-state/model.safetensors", "raw");

    const files = await listPreservableFiles({ worktreeDir, artifactPaths: ["assets/final/lora"] });

    expect(files).toEqual([
      "assets/final/lora/v2-step00000004-state/model.safetensors",
      "assets/final/lora/v2-step00000004-state/optimizer.bin"
    ]);
  });

  it("never lists a tracked file, even one sitting inside an allowlisted path", async () => {
    await writeFile(worktreeDir, "assets/final/lora/README.md", "committed\n");
    await git(["add", "assets/final/lora/README.md"], worktreeDir);
    await git(["commit", "-m", "track a lora file"], worktreeDir);

    const files = await listPreservableFiles({ worktreeDir, artifactPaths: ["assets/final/lora"] });
    expect(files).toEqual([]);
  });
});

describe("preserveArtifacts", () => {
  it("moves allowlisted artifacts into the card's cache (a move, so peak disk never doubles)", async () => {
    await writeFile(worktreeDir, "assets/final/lora/v2-step00000004-state/optimizer.bin", "state");
    await writeFile(worktreeDir, "assets/final/lora/v2-step00000004.safetensors", "weights");

    const result = await preserveArtifacts({ worktreeDir, cacheRoot, cardId: "T-0248" });

    expect(result.preserved).toEqual([
      "assets/final/lora/v2-step00000004-state/optimizer.bin",
      "assets/final/lora/v2-step00000004.safetensors"
    ]);
    const filesDir = path.join(cacheRoot, "T-0248", "files");
    expect(await readFile(filesDir, "assets/final/lora/v2-step00000004.safetensors")).toBe("weights");
    // Moved, not copied.
    expect(await exists(path.join(worktreeDir, "assets/final/lora/v2-step00000004.safetensors"))).toBe(false);

    const manifest = JSON.parse(await readFile(path.join(cacheRoot, "T-0248"), "manifest.json"));
    expect(manifest.cardId).toBe("T-0248");
    expect(manifest.paths).toEqual(result.preserved);
  });

  it("is a clean no-op for a fresh card whose worktree does not exist yet", async () => {
    const result = await preserveArtifacts({
      worktreeDir: path.join(tmpDir, "worktrees", "T-9999"),
      cacheRoot,
      cardId: "T-9999"
    });

    expect(result).toEqual({ preserved: [], cacheDir: null });
    expect(await exists(cacheRoot)).toBe(false);
  });

  it("is a clean no-op for a worktree that holds no allowlisted artifacts", async () => {
    await writeFile(worktreeDir, "src/scratch.txt", "nothing worth keeping");

    const result = await preserveArtifacts({ worktreeDir, cacheRoot, cardId: "T-0248" });

    expect(result.preserved).toEqual([]);
    expect(await exists(cacheRoot)).toBe(false);
  });

  it("keeps an existing cache when there is nothing new to capture, so a crashed reclaim does not lose its checkpoints", async () => {
    await writeFile(worktreeDir, "assets/final/lora/v2-step00000004.safetensors", "weights");
    await preserveArtifacts({ worktreeDir, cacheRoot, cardId: "T-0248" });

    // Second capture with an emptied worktree -- the shape of a reclaim that moved artifacts out
    // and then died before the worktree was re-created.
    const result = await preserveArtifacts({ worktreeDir, cacheRoot, cardId: "T-0248" });

    expect(result.preserved).toEqual([]);
    expect(await readFile(path.join(cacheRoot, "T-0248", "files"), "assets/final/lora/v2-step00000004.safetensors")).toBe(
      "weights"
    );
  });

  it("replaces the previous snapshot rather than accumulating generations", async () => {
    await writeFile(worktreeDir, "assets/final/lora/v2-step00000004.safetensors", "old");
    await preserveArtifacts({ worktreeDir, cacheRoot, cardId: "T-0248" });

    await writeFile(worktreeDir, "assets/final/lora/v2-step00000008.safetensors", "new");
    await preserveArtifacts({ worktreeDir, cacheRoot, cardId: "T-0248" });

    const filesDir = path.join(cacheRoot, "T-0248", "files", "assets", "final", "lora");
    expect((await fs.readdir(filesDir)).sort()).toEqual(["v2-step00000008.safetensors"]);
  });
});

describe("restoreArtifacts", () => {
  it("puts preserved artifacts back into a fresh worktree", async () => {
    await writeFile(worktreeDir, "assets/final/lora/v2-step00000004-state/optimizer.bin", "state");
    await preserveArtifacts({ worktreeDir, cacheRoot, cardId: "T-0248" });

    const result = await restoreArtifacts({ worktreeDir, cacheRoot, cardId: "T-0248" });

    expect(result.restored).toEqual(["assets/final/lora/v2-step00000004-state/optimizer.bin"]);
    expect(result.skippedTracked).toEqual([]);
    expect(await readFile(worktreeDir, "assets/final/lora/v2-step00000004-state/optimizer.bin")).toBe("state");
    // Fully drained, so the cache does not hold a second copy of a 2 GB checkpoint set.
    expect(await exists(path.join(cacheRoot, "T-0248"))).toBe(false);
  });

  it("never overwrites a file the fresh checkout tracks, and leaves that copy cached rather than deleting it", async () => {
    // A path that was untracked when captured but is committed by the time the card is re-run.
    await writeFile(worktreeDir, "assets/final/lora/config.toml", "stale");
    await preserveArtifacts({ worktreeDir, cacheRoot, cardId: "T-0248" });

    await writeFile(worktreeDir, "assets/final/lora/config.toml", "fresh from the branch");
    await git(["add", "assets/final/lora/config.toml"], worktreeDir);
    await git(["commit", "-m", "commit the config"], worktreeDir);

    const result = await restoreArtifacts({ worktreeDir, cacheRoot, cardId: "T-0248" });

    expect(result.restored).toEqual([]);
    expect(result.skippedTracked).toEqual(["assets/final/lora/config.toml"]);
    expect(await readFile(worktreeDir, "assets/final/lora/config.toml")).toBe("fresh from the branch");
    expect(await readFile(path.join(cacheRoot, "T-0248", "files"), "assets/final/lora/config.toml")).toBe("stale");
  });

  it("restores the untracked artifacts even when a sibling path is skipped as tracked", async () => {
    await writeFile(worktreeDir, "assets/final/lora/config.toml", "stale");
    await writeFile(worktreeDir, "assets/final/lora/v2-step00000004.safetensors", "weights");
    await preserveArtifacts({ worktreeDir, cacheRoot, cardId: "T-0248" });

    await writeFile(worktreeDir, "assets/final/lora/config.toml", "fresh");
    await git(["add", "assets/final/lora/config.toml"], worktreeDir);
    await git(["commit", "-m", "commit the config"], worktreeDir);

    const result = await restoreArtifacts({ worktreeDir, cacheRoot, cardId: "T-0248" });

    expect(result.restored).toEqual(["assets/final/lora/v2-step00000004.safetensors"]);
    expect(result.skippedTracked).toEqual(["assets/final/lora/config.toml"]);
    expect(await readFile(worktreeDir, "assets/final/lora/v2-step00000004.safetensors")).toBe("weights");
  });

  it("is a clean no-op for a card that has nothing cached", async () => {
    const result = await restoreArtifacts({ worktreeDir, cacheRoot, cardId: "T-9999" });
    expect(result).toEqual({ restored: [], skippedTracked: [] });
  });
});

describe("cache cleanup", () => {
  it("clearPreservedArtifacts drops a card's cache and is idempotent", async () => {
    await writeFile(worktreeDir, "assets/final/lora/v2-step00000004.safetensors", "weights");
    await preserveArtifacts({ worktreeDir, cacheRoot, cardId: "T-0248" });
    expect(await exists(path.join(cacheRoot, "T-0248"))).toBe(true);

    await clearPreservedArtifacts({ cacheRoot, cardId: "T-0248" });
    expect(await exists(path.join(cacheRoot, "T-0248"))).toBe(false);

    await expect(clearPreservedArtifacts({ cacheRoot, cardId: "T-0248" })).resolves.not.toThrow();
  });

  it("pruneArtifactCache bounds the cache to the most recently written cards", async () => {
    for (const cardId of ["T-0001", "T-0002", "T-0003"]) {
      const dir = path.join(cacheRoot, cardId, "files");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "artifact.bin"), cardId, "utf8");
      // Distinct mtimes so "least recently written" is well defined.
      const when = new Date(2026, 0, Number(cardId.slice(-1)));
      await fs.utimes(path.join(cacheRoot, cardId), when, when);
    }

    const evicted = await pruneArtifactCache({ cacheRoot, maxCards: 2 });

    expect(evicted).toEqual(["T-0001"]);
    expect((await fs.readdir(cacheRoot)).sort()).toEqual(["T-0002", "T-0003"]);
  });

  it("pruneArtifactCache is a no-op on a cache root that was never created", async () => {
    await expect(pruneArtifactCache({ cacheRoot, maxCards: 2 })).resolves.toEqual([]);
  });

  it("preserveArtifacts applies the bound as it writes", async () => {
    for (const cardId of ["T-0001", "T-0002"]) {
      const dir = path.join(cacheRoot, cardId, "files");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "artifact.bin"), cardId, "utf8");
      const when = new Date(2020, 0, 1);
      await fs.utimes(path.join(cacheRoot, cardId), when, when);
    }
    await writeFile(worktreeDir, "assets/final/lora/v2-step00000004.safetensors", "weights");

    await preserveArtifacts({ worktreeDir, cacheRoot, cardId: "T-0248", maxCards: 1 });

    expect(await fs.readdir(cacheRoot)).toEqual(["T-0248"]);
  });
});

describe("artifactCacheRootFor", () => {
  it("nests the cache alongside the card worktrees, on the same filesystem they live on", () => {
    expect(artifactCacheRootFor({ worktreesDir: path.join("/repo", "worktrees") })).toBe(
      path.join("/repo", "worktrees", ARTIFACT_CACHE_DIRNAME)
    );
  });
});
