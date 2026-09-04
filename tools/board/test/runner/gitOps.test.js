import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmTemp } from "../helpers/rmTemp.js";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import {
  addWorktree,
  removeWorktree,
  diffNames,
  hasUncommittedChanges,
  commitAll,
  push,
  getHeadCommit,
  pullDevelop,
  isBehindOrigin,
  syncBaseBranch,
  mergeNoFF,
  mergeOriginRef,
  fetch,
  mergeDevelop,
  mergeStatus,
  abortMerge,
  commitTaskFile,
  commitPaths,
  autoCommitCardsOnCreateFromEnv,
  linkBoardNodeModules,
  BOARD_COMMIT_AUTHOR
} from "../../src/runner/gitOps.js";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

let tmpDir;
let originDir;
let repoRoot;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-gitops-"));
  originDir = path.join(tmpDir, "origin.git");
  repoRoot = path.join(tmpDir, "repo");

  await fs.mkdir(originDir, { recursive: true });
  await git(["init", "--bare", "-b", "main"], originDir);

  await fs.mkdir(repoRoot, { recursive: true });
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "test@example.com"], repoRoot);
  await git(["config", "user.name", "Test"], repoRoot);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"], repoRoot);
  await git(["commit", "-m", "initial"], repoRoot);
  await git(["remote", "add", "origin", originDir], repoRoot);
  await git(["push", "-u", "origin", "main"], repoRoot);
  await git(["checkout", "-b", "develop"], repoRoot);
  await git(["push", "-u", "origin", "develop"], repoRoot);
});

afterEach(async () => {
  // rmTemp, not a bare fs.rm: git's background repacking can write into .git/objects/pack
  // between this walk's readdir and its rmdir, which surfaced in CI as
  // "ENOTEMPTY: directory not empty, rmdir '.../.git/objects/pack'" while passing locally.
  await rmTemp(tmpDir);
});

describe("addWorktree / removeWorktree", () => {
  it("creates a worktree on a new branch cut from develop", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0099");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0099", baseBranch: "develop" });

    const stat = await fs.stat(worktreeDir);
    expect(stat.isDirectory()).toBe(true);
    const { stdout: branch } = await git(["rev-parse", "--abbrev-ref", "HEAD"], worktreeDir);
    expect(branch.trim()).toBe("feature/T-0099");

    const { stdout: list } = await git(["worktree", "list"], repoRoot);
    expect(list).toContain(worktreeDir);
  });

  it("removes a worktree, dropping it from git worktree list", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0100");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0100", baseBranch: "develop" });

    await removeWorktree({ repoRoot, worktreeDir });

    const { stdout: list } = await git(["worktree", "list"], repoRoot);
    expect(list).not.toContain(worktreeDir);
    await expect(fs.stat(worktreeDir)).rejects.toThrow();
  });

  it("force-removes a worktree even with uncommitted changes", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0101");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0101", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "dirty.txt"), "uncommitted\n", "utf8");

    await expect(removeWorktree({ repoRoot, worktreeDir })).resolves.not.toThrow();
  });
});

describe("addWorktree — stale branch/worktree recovery", () => {
  it("auto-cleans a stale branch+worktree with no unique commits (dead attempt) and proceeds", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0100");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0100", baseBranch: "develop" });
    // Simulate the run dying immediately -- worktree + branch left behind, nothing ever committed.

    await expect(
      addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0100", baseBranch: "develop" })
    ).resolves.not.toThrow();

    const stat = await fs.stat(worktreeDir);
    expect(stat.isDirectory()).toBe(true);
    const { stdout: branch } = await git(["rev-parse", "--abbrev-ref", "HEAD"], worktreeDir);
    expect(branch.trim()).toBe("feature/T-0100");
  });

  it("auto-cleans a stale branch that has since been fully merged into develop", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0102b");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0102b", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "merged.txt"), "x\n", "utf8");
    await commitAll({ worktreeDir, message: "feat: merged work" });
    await removeWorktree({ repoRoot, worktreeDir });
    await git(["checkout", "develop"], repoRoot);
    await git(["merge", "--no-ff", "feature/T-0102b"], repoRoot);
    // Branch is merged into develop but was never deleted -- also a "stale" leftover.

    await expect(
      addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0102b", baseBranch: "develop" })
    ).resolves.not.toThrow();

    const stat = await fs.stat(worktreeDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("reuses a branch with unique unpushed commits instead of destroying it, and reports reused: true", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0111");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0111", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "real-work.txt"), "important\n", "utf8");
    await commitAll({ worktreeDir, message: "feat: real work" });
    // Simulate the run dying after a real commit but before push -- must not be destroyed,
    // and a later addWorktree() for the same card (e.g. a re-run after review) continues on it.
    await removeWorktree({ repoRoot, worktreeDir });

    const result = await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0111", baseBranch: "develop" });

    expect(result).toMatchObject({ reused: true });
    const { stdout: branchSha } = await git(["rev-parse", "feature/T-0111"], repoRoot);
    expect(branchSha.trim().length).toBe(40);
    const stat = await fs.stat(worktreeDir);
    expect(stat.isDirectory()).toBe(true);
    const { stdout: log } = await git(["log", "-1", "--pretty=%s"], worktreeDir);
    expect(log.trim()).toBe("feat: real work");
    const { stdout: branch } = await git(["rev-parse", "--abbrev-ref", "HEAD"], worktreeDir);
    expect(branch.trim()).toBe("feature/T-0111");
    const { stdout: list } = await git(["worktree", "list"], repoRoot);
    expect(list).toContain(worktreeDir);
  });

  it("reuses a branch with unique commits even when its old worktree is still checked out (crashed run)", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0112");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0112", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "real-work.txt"), "important\n", "utf8");
    await commitAll({ worktreeDir, message: "feat: real work" });
    // Worktree left in place (no removeWorktree call) -- simulates a crash mid-run.

    const result = await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0112", baseBranch: "develop" });

    expect(result).toMatchObject({ reused: true });
    const { stdout: log } = await git(["log", "-1", "--pretty=%s"], worktreeDir);
    expect(log.trim()).toBe("feat: real work");
  });

  it("leaves normal (non-stale) worktree creation unchanged and reports reused: false", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0199");
    const result = await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0199", baseBranch: "develop" });

    expect(result).toMatchObject({ reused: false });
    const stat = await fs.stat(worktreeDir);
    expect(stat.isDirectory()).toBe(true);
    const { stdout: branch } = await git(["rev-parse", "--abbrev-ref", "HEAD"], worktreeDir);
    expect(branch.trim()).toBe("feature/T-0199");
  });

  it("reports reused: false when a stale branch with no unique commits is discarded", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0100b");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0100b", baseBranch: "develop" });

    const result = await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0100b", baseBranch: "develop" });

    expect(result).toMatchObject({ reused: false });
  });
});

/**
 * T-0248: the reclaim's `git worktree remove --force` deletes the whole directory, untracked and
 * ignored files included, so per-epoch LoRA training checkpoints were destroyed on every re-run
 * and `find_resume_state` restarted training from step 0 (~86 minutes of GPU, once). addWorktree
 * now carries the card's allowlisted untracked artifacts across the reclaim -- see
 * artifactPreservation.js.
 */
describe("addWorktree / removeWorktree — untracked artifacts survive the worktree reset", () => {
  const CHECKPOINT = "assets/final/lora/player_identity_v2-step00000024-state/optimizer.bin";
  const WEIGHTS = "assets/final/lora/player_identity_v2-step00000024.safetensors";

  async function writeIn(root, rel, contents) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), contents, "utf8");
  }

  async function exists(target) {
    try {
      await fs.lstat(target);
      return true;
    } catch {
      return false;
    }
  }

  it("a re-run finds the previous run's untracked checkpoints in the fresh worktree, so training can resume", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0248");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0248", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "training-glue.py"), "print('v1')\n", "utf8");
    await commitAll({ worktreeDir, message: "feat: training glue" });
    // Untracked training state, exactly as sd-scripts --save_state leaves it.
    await writeIn(worktreeDir, CHECKPOINT, "optimizer state");
    await writeIn(worktreeDir, WEIGHTS, "lora weights");

    const result = await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0248", baseBranch: "develop" });

    expect(result).toMatchObject({ reused: true });
    expect(await fs.readFile(path.join(worktreeDir, CHECKPOINT), "utf8")).toBe("optimizer state");
    expect(await fs.readFile(path.join(worktreeDir, WEIGHTS), "utf8")).toBe("lora weights");
    // Restored, not merely stashed: nothing is left behind holding a second copy.
    expect(await exists(path.join(tmpDir, "worktrees", ".artifact-cache", "T-0248"))).toBe(false);
  });

  it("does not carry across untracked files outside the artifact allowlist", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0249");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0249", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "work.txt"), "x\n", "utf8");
    await commitAll({ worktreeDir, message: "feat: work" });
    await writeIn(worktreeDir, CHECKPOINT, "optimizer state");
    await writeIn(worktreeDir, "assets/src/character/__pycache__/synth.pyc", "junk");
    await writeIn(worktreeDir, "scratch-notes.md", "junk");

    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0249", baseBranch: "develop" });

    expect(await exists(path.join(worktreeDir, CHECKPOINT))).toBe(true);
    expect(await exists(path.join(worktreeDir, "assets/src/character/__pycache__/synth.pyc"))).toBe(false);
    expect(await exists(path.join(worktreeDir, "scratch-notes.md"))).toBe(false);
  });

  it("never overwrites a tracked file in the fresh checkout with a preserved stale copy", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0250");
    const config = "assets/final/lora/training_config.toml";
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0250", baseBranch: "develop" });
    // Untracked when captured...
    await writeIn(worktreeDir, config, "stale = true\n");
    await writeIn(worktreeDir, CHECKPOINT, "optimizer state");

    // ...but committed on the base branch by the time the card is re-run. The card branch has no
    // unique commits, so the reclaim discards it and cuts a fresh one from develop -- and the
    // fresh checkout's version of that path is the one that must win.
    await git(["checkout", "develop"], repoRoot);
    await fs.mkdir(path.join(repoRoot, path.dirname(config)), { recursive: true });
    await fs.writeFile(path.join(repoRoot, config), "fresh = true\n", "utf8");
    await git(["add", config], repoRoot);
    await git(["commit", "-m", "feat: commit the training config"], repoRoot);

    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0250", baseBranch: "develop" });

    expect(await fs.readFile(path.join(worktreeDir, config), "utf8")).toBe("fresh = true\n");
    // The genuinely untracked artifact alongside it still comes back.
    expect(await fs.readFile(path.join(worktreeDir, CHECKPOINT), "utf8")).toBe("optimizer state");
  });

  it("leaves a fresh card with no prior worktree completely unaffected", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0251");

    const result = await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0251", baseBranch: "develop" });

    expect(result).toMatchObject({ reused: false });
    expect((await fs.stat(worktreeDir)).isDirectory()).toBe(true);
    expect(await exists(path.join(tmpDir, "worktrees", ".artifact-cache"))).toBe(false);
  });

  it("preserves artifacts through removeWorktree too, so a card re-run after review still resumes", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0252");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0252", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "work.txt"), "x\n", "utf8");
    await commitAll({ worktreeDir, message: "feat: work" });
    await writeIn(worktreeDir, CHECKPOINT, "optimizer state");

    // The PASS path: branch pushed, PR opened, worktree torn down.
    await removeWorktree({ repoRoot, worktreeDir });
    expect(await exists(worktreeDir)).toBe(false);

    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0252", baseBranch: "develop" });

    expect(await fs.readFile(path.join(worktreeDir, CHECKPOINT), "utf8")).toBe("optimizer state");
  });

  it("honours BOARD_PRESERVE_ARTIFACTS=off by falling back to the old wipe-on-reclaim behaviour", async () => {
    const previous = process.env.BOARD_PRESERVE_ARTIFACTS;
    process.env.BOARD_PRESERVE_ARTIFACTS = "off";
    try {
      const worktreeDir = path.join(tmpDir, "worktrees", "T-0253");
      await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0253", baseBranch: "develop" });
      await fs.writeFile(path.join(worktreeDir, "work.txt"), "x\n", "utf8");
      await commitAll({ worktreeDir, message: "feat: work" });
      await writeIn(worktreeDir, CHECKPOINT, "optimizer state");

      await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0253", baseBranch: "develop" });

      expect(await exists(path.join(worktreeDir, CHECKPOINT))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BOARD_PRESERVE_ARTIFACTS;
      else process.env.BOARD_PRESERVE_ARTIFACTS = previous;
    }
  });
});

describe("hasUncommittedChanges / commitAll", () => {
  it("reports false and skips committing when the worktree is clean", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0102");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0102", baseBranch: "develop" });

    expect(await hasUncommittedChanges({ worktreeDir })).toBe(false);
    expect(await commitAll({ worktreeDir, message: "no-op" })).toBe(false);
  });

  it("stages and commits every change in the worktree", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0103");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0103", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "new-file.txt"), "content\n", "utf8");

    expect(await hasUncommittedChanges({ worktreeDir })).toBe(true);
    const committed = await commitAll({ worktreeDir, message: "feat: add new-file" });
    expect(committed).toBe(true);
    expect(await hasUncommittedChanges({ worktreeDir })).toBe(false);

    const { stdout: log } = await git(["log", "-1", "--pretty=%s"], worktreeDir);
    expect(log.trim()).toBe("feat: add new-file");
  });

  it("commits with the given author identity instead of the ambient git config when `author` is passed", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0114");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0114", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "captured.txt"), "content\n", "utf8");

    const committed = await commitAll({
      worktreeDir,
      message: "chore(T-0114): capture uncommitted implementer changes",
      author: BOARD_COMMIT_AUTHOR
    });

    expect(committed).toBe(true);
    const { stdout: authorName } = await git(["log", "-1", "--pretty=%an"], worktreeDir);
    const { stdout: authorEmail } = await git(["log", "-1", "--pretty=%ae"], worktreeDir);
    expect(authorName.trim()).toBe("assembled-board");
    expect(authorEmail.trim()).toBe("board@localhost");
  });

  it("commits with the ambient git identity when no `author` is passed (unchanged default behavior)", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0115");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0115", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "normal.txt"), "content\n", "utf8");

    await commitAll({ worktreeDir, message: "feat: normal commit" });

    const { stdout: authorName } = await git(["log", "-1", "--pretty=%an"], worktreeDir);
    expect(authorName.trim()).toBe("Test");
  });
});

describe("diffNames", () => {
  it("lists the file paths changed relative to the base branch", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0104");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0104", baseBranch: "develop" });
    await fs.mkdir(path.join(worktreeDir, "tools", "board", "src"), { recursive: true });
    await fs.writeFile(path.join(worktreeDir, "tools", "board", "src", "thing.js"), "x\n", "utf8");
    await commitAll({ worktreeDir, message: "feat: add thing.js" });

    const names = await diffNames({ worktreeDir, baseBranch: "develop" });
    expect(names).toEqual(["tools/board/src/thing.js"]);
  });

  it("returns an empty array when nothing has changed", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0105");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0105", baseBranch: "develop" });

    expect(await diffNames({ worktreeDir, baseBranch: "develop" })).toEqual([]);
  });
});

describe("getHeadCommit", () => {
  it("returns the full SHA of the worktree's current HEAD", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0107");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0107", baseBranch: "develop" });

    const sha = await getHeadCommit({ worktreeDir });

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const { stdout: expected } = await git(["rev-parse", "HEAD"], worktreeDir);
    expect(sha).toBe(expected.trim());
  });

  it("reflects a new commit made in the worktree", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0108");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0108", baseBranch: "develop" });
    const before = await getHeadCommit({ worktreeDir });

    await fs.writeFile(path.join(worktreeDir, "new.txt"), "x\n", "utf8");
    await commitAll({ worktreeDir, message: "feat: add new.txt" });

    const after = await getHeadCommit({ worktreeDir });
    expect(after).not.toBe(before);
  });
});

describe("push", () => {
  it("pushes the branch to origin with upstream set", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0106");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0106", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "pushed.txt"), "x\n", "utf8");
    await commitAll({ worktreeDir, message: "feat: pushed file" });

    await push({ worktreeDir, branch: "feature/T-0106" });

    const { stdout: branches } = await git(["branch", "-r"], repoRoot);
    expect(branches).toContain("origin/feature/T-0106");
  });

  it("force: true pushes with --force-with-lease, overwriting a diverged remote history for the same card's branch", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0113");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0113", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "v1.txt"), "v1\n", "utf8");
    await commitAll({ worktreeDir, message: "feat: v1" });
    await push({ worktreeDir, branch: "feature/T-0113" });

    // Continuing the card: amend the commit locally so it no longer fast-forwards from origin.
    await fs.writeFile(path.join(worktreeDir, "v1.txt"), "v2\n", "utf8");
    await git(["add", "-A"], worktreeDir);
    await git(["commit", "--amend", "-m", "feat: v2 (fixed)"], worktreeDir);

    await expect(push({ worktreeDir, branch: "feature/T-0113" })).rejects.toThrow();
    await expect(push({ worktreeDir, branch: "feature/T-0113", force: true })).resolves.not.toThrow();

    await git(["fetch", "origin", "feature/T-0113"], repoRoot);
    const { stdout: log } = await git(["log", "-1", "--pretty=%s", "FETCH_HEAD"], repoRoot);
    expect(log.trim()).toBe("feat: v2 (fixed)");
  });
});

describe("pullDevelop", () => {
  it("fast-forwards develop when origin has new commits -- no merge commit when there's nothing local to preserve", async () => {
    // Push a new commit to origin's develop from a separate clone
    const cloneDir = path.join(tmpDir, "other-clone");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "upstream.txt"), "from upstream\n", "utf8");
    await git(["add", "upstream.txt"], cloneDir);
    await git(["commit", "-m", "upstream: new commit"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);

    await pullDevelop({ repoRoot, branch: "develop" });

    const { stdout: log } = await git(["log", "--oneline", "develop"], repoRoot);
    expect(log).toContain("upstream: new commit");
    const { stdout: parents } = await git(["log", "-1", "--pretty=%P", "develop"], repoRoot);
    expect(parents.trim().split(" ").filter(Boolean).length).toBe(1); // fast-forward, not a merge commit
  });

  // T-0304: this reproduces the live-board bug directly -- a `merge.ff=false`-style config
  // (plausible on the deploy machine, distinct from this sandbox's default config) makes plain
  // `git pull --no-rebase` manufacture a merge commit even when repoRoot is a pure ancestor of
  // origin/develop with nothing local to preserve. The fix must not rely on ambient merge.ff/
  // pull.ff config at all -- it has to check explicitly.
  it("still fast-forwards with no merge commit under a merge.ff=false-style config", async () => {
    await git(["config", "merge.ff", "false"], repoRoot);

    const cloneDir = path.join(tmpDir, "other-clone-mergeff-false");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "upstream-mergeff.txt"), "from upstream\n", "utf8");
    await git(["add", "upstream-mergeff.txt"], cloneDir);
    await git(["commit", "-m", "upstream: commit under merge.ff=false"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);

    await pullDevelop({ repoRoot, branch: "develop" });

    const { stdout: parents } = await git(["log", "-1", "--pretty=%P", "develop"], repoRoot);
    expect(parents.trim().split(" ").filter(Boolean).length).toBe(1); // still a fast-forward
  });

  it("resolves without error when develop is already up to date", async () => {
    await expect(pullDevelop({ repoRoot, branch: "develop" })).resolves.not.toThrow();
  });

  it("rejects with a descriptive error when the branch does not exist on origin", async () => {
    await expect(pullDevelop({ repoRoot, branch: "nonexistent-branch" })).rejects.toThrow(
      /nonexistent-branch|git pull/i
    );
  });

  it("reports advanced: true and the before/after SHAs when origin has new commits", async () => {
    const cloneDir = path.join(tmpDir, "other-clone-advanced");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "upstream2.txt"), "from upstream\n", "utf8");
    await git(["add", "upstream2.txt"], cloneDir);
    await git(["commit", "-m", "upstream: another commit"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);

    const { stdout: expectedBefore } = await git(["rev-parse", "HEAD"], repoRoot);

    const result = await pullDevelop({ repoRoot, branch: "develop" });

    const { stdout: expectedAfter } = await git(["rev-parse", "HEAD"], repoRoot);
    expect(result.advanced).toBe(true);
    expect(result.before).toBe(expectedBefore.trim());
    expect(result.after).toBe(expectedAfter.trim());
    expect(result.after).not.toBe(result.before);
  });

  it("reports advanced: false when develop is already up to date", async () => {
    const result = await pullDevelop({ repoRoot, branch: "develop" });
    expect(result.advanced).toBe(false);
    expect(result.before).toBe(result.after);
  });

  it("merges cleanly when repoRoot has local unpushed commits AND origin has new commits (divergent histories)", async () => {
    // This is the exact shape a card-on-create commit produces: repoRoot's local `develop`
    // gets a commit origin doesn't have, then a card moves to Done and triggers pullDevelop
    // while origin has *also* moved on (another PR merged). Must not fail or wedge the pull.
    await fs.mkdir(path.join(repoRoot, "tasks"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tasks", "T-0001.md"), "local card\n", "utf8");
    await git(["add", "-A"], repoRoot);
    await git(["commit", "-m", "chore(board): add card T-0001"], repoRoot);

    const cloneDir = path.join(tmpDir, "other-clone-divergent");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "upstream3.txt"), "from upstream\n", "utf8");
    await git(["add", "upstream3.txt"], cloneDir);
    await git(["commit", "-m", "upstream: unrelated commit"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);

    await expect(pullDevelop({ repoRoot, branch: "develop" })).resolves.toMatchObject({ advanced: true });

    // Both the local card commit and the upstream commit must survive the merge.
    const { stdout: log } = await git(["log", "--oneline", "develop"], repoRoot);
    expect(log).toContain("chore(board): add card T-0001");
    expect(log).toContain("upstream: unrelated commit");
    const cardFile = await fs.readFile(path.join(repoRoot, "tasks", "T-0001.md"), "utf8");
    expect(cardFile).toBe("local card\n");
  });

  it("does not fail under a pull.ff=only global-style config, since --no-rebase forces a real merge", async () => {
    await git(["config", "pull.ff", "only"], repoRoot);
    await fs.mkdir(path.join(repoRoot, "tasks"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tasks", "T-0002.md"), "local card\n", "utf8");
    await git(["add", "-A"], repoRoot);
    await git(["commit", "-m", "chore(board): add card T-0002"], repoRoot);

    const cloneDir = path.join(tmpDir, "other-clone-ffonly");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "upstream4.txt"), "from upstream\n", "utf8");
    await git(["add", "upstream4.txt"], cloneDir);
    await git(["commit", "-m", "upstream: another unrelated commit"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);

    await expect(pullDevelop({ repoRoot, branch: "develop" })).resolves.toMatchObject({ advanced: true });
  });

  it("aborts the merge and rethrows on conflict, leaving a clean working tree behind (not wedged mid-merge)", async () => {
    // Regression coverage: unlike mergeNoFF (below), pullDevelop used to have no
    // merge --abort safety net on failure -- a real content conflict (not just a dirty
    // working tree) left repoRoot permanently stuck mid-merge with conflict markers on
    // disk, blocking every subsequent commit ("cannot do a partial commit during a merge")
    // and every subsequent pull ("Pulling is not possible because you have unmerged
    // files") until someone resolved it by hand.
    await fs.writeFile(path.join(repoRoot, "conflict.txt"), "local version\n", "utf8");
    await git(["add", "conflict.txt"], repoRoot);
    await git(["commit", "-m", "local: conflicting change"], repoRoot);

    const cloneDir = path.join(tmpDir, "other-clone-pull-conflict");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "conflict.txt"), "upstream version\n", "utf8");
    await git(["add", "conflict.txt"], cloneDir);
    await git(["commit", "-m", "upstream: conflicting change"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);

    await expect(pullDevelop({ repoRoot, branch: "develop" })).rejects.toThrow();

    // Working tree must be clean -- no leftover conflict markers -- not left mid-merge.
    const { stdout: status } = await git(["status", "--porcelain"], repoRoot);
    expect(status.trim()).toBe("");
    const { stdout: mergeHead } = await git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], repoRoot).catch(
      (err) => ({ stdout: "", err })
    );
    expect(mergeHead.trim()).toBe("");
    const conflictContent = await fs.readFile(path.join(repoRoot, "conflict.txt"), "utf8");
    expect(conflictContent).toBe("local version\n");

    // And a subsequent commit must succeed -- proof the repo isn't wedged.
    await fs.writeFile(path.join(repoRoot, "after.txt"), "post-conflict work\n", "utf8");
    await git(["add", "after.txt"], repoRoot);
    await expect(git(["commit", "-m", "local: work after aborted pull"], repoRoot)).resolves.toBeDefined();
  });
});

describe("isBehindOrigin", () => {
  it("returns false when repoRoot's develop already matches origin/develop", async () => {
    await expect(isBehindOrigin({ repoRoot, branch: "develop" })).resolves.toBe(false);
  });

  it("returns true once origin/develop has commits repoRoot doesn't have yet", async () => {
    const cloneDir = path.join(tmpDir, "other-clone-behind-check");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "upstream-behind.txt"), "from upstream\n", "utf8");
    await git(["add", "upstream-behind.txt"], cloneDir);
    await git(["commit", "-m", "upstream: commit repoRoot hasn't seen"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);

    await expect(isBehindOrigin({ repoRoot, branch: "develop" })).resolves.toBe(true);
  });

  it("returns false when repoRoot is only ahead of origin (local unpushed commit, nothing new upstream)", async () => {
    await fs.writeFile(path.join(repoRoot, "local-only.txt"), "local\n", "utf8");
    await git(["add", "local-only.txt"], repoRoot);
    await git(["commit", "-m", "local: unpushed commit"], repoRoot);

    await expect(isBehindOrigin({ repoRoot, branch: "develop" })).resolves.toBe(false);
  });

  it("returns true when histories diverged (repoRoot has an unpushed commit AND origin moved on)", async () => {
    await fs.writeFile(path.join(repoRoot, "local-diverge.txt"), "local\n", "utf8");
    await git(["add", "local-diverge.txt"], repoRoot);
    await git(["commit", "-m", "local: unpushed commit"], repoRoot);

    const cloneDir = path.join(tmpDir, "other-clone-diverged");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "upstream-diverge.txt"), "from upstream\n", "utf8");
    await git(["add", "upstream-diverge.txt"], cloneDir);
    await git(["commit", "-m", "upstream: diverged commit"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);

    await expect(isBehindOrigin({ repoRoot, branch: "develop" })).resolves.toBe(true);
  });
});

describe("mergeNoFF", () => {
  // T-0304: this was the deploy.sh-shaped bug reproduced directly against the shared gitOps
  // function autoPush.js also relies on -- mergeNoFF used to pass --no-ff unconditionally, so
  // even a trivially fast-forwardable pull (nothing local to preserve) manufactured an empty
  // merge commit every time. It must fast-forward here instead, and only fall back to --no-ff
  // when local genuinely has commits origin doesn't (covered below).
  it("fast-forwards -- no merge commit -- when there's nothing local to preserve", async () => {
    const cloneDir = path.join(tmpDir, "other-clone-mergenoff");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "upstream.txt"), "from upstream\n", "utf8");
    await git(["add", "upstream.txt"], cloneDir);
    await git(["commit", "-m", "upstream: new commit"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);

    await mergeNoFF({ repoRoot, branch: "develop" });

    const { stdout: log } = await git(["log", "--oneline", "develop"], repoRoot);
    expect(log).toContain("upstream: new commit");
    const { stdout: parents } = await git(["log", "-1", "--pretty=%P", "develop"], repoRoot);
    expect(parents.trim().split(" ").filter(Boolean).length).toBe(1); // fast-forward, not a merge commit
  });

  it("falls back to a real --no-ff merge commit when local genuinely has commits origin doesn't -- the case --no-ff exists for", async () => {
    await fs.writeFile(path.join(repoRoot, "local-only.txt"), "local\n", "utf8");
    await git(["add", "local-only.txt"], repoRoot);
    await git(["commit", "-m", "local: unpushed runtime commit"], repoRoot);

    const cloneDir = path.join(tmpDir, "other-clone-mergenoff-diverged");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "upstream-diverged.txt"), "from upstream\n", "utf8");
    await git(["add", "upstream-diverged.txt"], cloneDir);
    await git(["commit", "-m", "upstream: new commit"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);

    await mergeNoFF({ repoRoot, branch: "develop" });

    const { stdout: parents } = await git(["log", "-1", "--pretty=%P", "develop"], repoRoot);
    expect(parents.trim().split(" ").filter(Boolean).length).toBe(2); // real merge commit -- both sides preserved
    const localFile = await fs.readFile(path.join(repoRoot, "local-only.txt"), "utf8");
    expect(localFile).toBe("local\n");
    const upstreamFile = await fs.readFile(path.join(repoRoot, "upstream-diverged.txt"), "utf8");
    expect(upstreamFile).toBe("from upstream\n");
  });

  it("is a true no-op -- no commit at all -- when already up to date", async () => {
    const { stdout: beforeSha } = await git(["rev-parse", "develop"], repoRoot);
    await expect(mergeNoFF({ repoRoot, branch: "develop" })).resolves.not.toThrow();
    const { stdout: afterSha } = await git(["rev-parse", "develop"], repoRoot);
    expect(afterSha.trim()).toBe(beforeSha.trim());
  });

  it("aborts the merge and rethrows on conflict, leaving a clean working tree behind", async () => {
    await fs.writeFile(path.join(repoRoot, "conflict.txt"), "local version\n", "utf8");
    await git(["add", "conflict.txt"], repoRoot);
    await git(["commit", "-m", "local: conflicting change"], repoRoot);

    const cloneDir = path.join(tmpDir, "other-clone-conflict");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "conflict.txt"), "upstream version\n", "utf8");
    await git(["add", "conflict.txt"], cloneDir);
    await git(["commit", "-m", "upstream: conflicting change"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);

    await expect(mergeNoFF({ repoRoot, branch: "develop" })).rejects.toThrow();

    // Working tree must be clean -- no leftover conflict markers -- not left mid-merge.
    const { stdout: status } = await git(["status", "--porcelain"], repoRoot);
    expect(status.trim()).toBe("");
    const { stdout: mergeHead } = await git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], repoRoot).catch(
      (err) => ({ stdout: "", err })
    );
    expect(mergeHead.trim()).toBe("");
    const conflictContent = await fs.readFile(path.join(repoRoot, "conflict.txt"), "utf8");
    expect(conflictContent).toBe("local version\n");
  });

  it("rejects with a descriptive error when the branch does not exist on origin", async () => {
    await expect(mergeNoFF({ repoRoot, branch: "nonexistent-branch" })).rejects.toThrow(/nonexistent-branch|git/i);
  });
});

// T-0304: deploy.sh runs its own explicit `git fetch` step first (so it can give a distinct
// "fetch failed" error message), then merges the already-fetched origin/<branch> ref via this
// function -- the no-fetch counterpart to mergeNoFF, which bundles the fetch in for callers
// (the auto-pull poller via pullDevelop, and autoPush.js's push-retry path) that don't fetch
// separately. Same ff-then-no-ff-fallback behavior either way.
describe("mergeOriginRef", () => {
  it("fast-forwards an already-fetched origin/<branch> when there's nothing local to preserve", async () => {
    const cloneDir = path.join(tmpDir, "other-clone-mergeoriginref-ff");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "upstream.txt"), "from upstream\n", "utf8");
    await git(["add", "upstream.txt"], cloneDir);
    await git(["commit", "-m", "upstream: new commit"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);
    await git(["fetch", "origin", "develop"], repoRoot);

    await mergeOriginRef({ repoRoot, branch: "develop" });

    const { stdout: parents } = await git(["log", "-1", "--pretty=%P", "develop"], repoRoot);
    expect(parents.trim().split(" ").filter(Boolean).length).toBe(1);
  });

  it("falls back to --no-ff when local genuinely has commits origin doesn't, and aborts+rethrows on conflict", async () => {
    await fs.writeFile(path.join(repoRoot, "conflict.txt"), "local version\n", "utf8");
    await git(["add", "conflict.txt"], repoRoot);
    await git(["commit", "-m", "local: conflicting change"], repoRoot);

    const cloneDir = path.join(tmpDir, "other-clone-mergeoriginref-conflict");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "conflict.txt"), "upstream version\n", "utf8");
    await git(["add", "conflict.txt"], cloneDir);
    await git(["commit", "-m", "upstream: conflicting change"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);
    await git(["fetch", "origin", "develop"], repoRoot);

    await expect(mergeOriginRef({ repoRoot, branch: "develop" })).rejects.toThrow();

    const { stdout: status } = await git(["status", "--porcelain"], repoRoot);
    expect(status.trim()).toBe("");
    const { stdout: mergeHead } = await git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], repoRoot).catch(
      (err) => ({ stdout: "", err })
    );
    expect(mergeHead.trim()).toBe("");
  });
});

describe("fetch", () => {
  it("updates origin's remote-tracking refs in the worktree without touching the working tree", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0200");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0200", baseBranch: "develop" });

    const cloneDir = path.join(tmpDir, "other-clone-fetch");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "upstream.txt"), "from upstream\n", "utf8");
    await git(["add", "upstream.txt"], cloneDir);
    await git(["commit", "-m", "upstream: new commit"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);

    await expect(fetch({ worktreeDir })).resolves.not.toThrow();

    const { stdout: log } = await git(["log", "--oneline", "origin/develop"], worktreeDir);
    expect(log).toContain("upstream: new commit");
    // Working tree/branch itself is untouched -- fetch never merges.
    const { stdout: branchLog } = await git(["log", "--oneline", "feature/T-0200"], worktreeDir);
    expect(branchLog).not.toContain("upstream: new commit");
  });
});

describe("mergeDevelop", () => {
  it("merges origin/<baseBranch> into the branch cleanly when there's no conflict -- conflicted:false, changed:true", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0201");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0201", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "feature.txt"), "feature work\n", "utf8");
    await commitAll({ worktreeDir, message: "feat: feature work" });

    const cloneDir = path.join(tmpDir, "other-clone-mergedevelop-clean");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "upstream.txt"), "from upstream\n", "utf8");
    await git(["add", "upstream.txt"], cloneDir);
    await git(["commit", "-m", "upstream: new commit"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);

    await fetch({ worktreeDir });
    const result = await mergeDevelop({ worktreeDir, baseBranch: "develop" });

    expect(result).toMatchObject({ conflicted: false, changed: true });
    const { stdout: log } = await git(["log", "--oneline", "-5"], worktreeDir);
    expect(log).toContain("upstream: new commit");
    expect(log).toContain("feat: feature work");
    const upstreamFile = await fs.readFile(path.join(worktreeDir, "upstream.txt"), "utf8");
    expect(upstreamFile).toBe("from upstream\n");
    const { stdout: status } = await git(["status", "--porcelain"], worktreeDir);
    expect(status.trim()).toBe("");
  });

  it("returns changed:false when the branch already contains everything on origin/<baseBranch>", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0202");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0202", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "feature.txt"), "feature work\n", "utf8");
    await commitAll({ worktreeDir, message: "feat: feature work" });

    await fetch({ worktreeDir });
    const result = await mergeDevelop({ worktreeDir, baseBranch: "develop" });

    expect(result).toMatchObject({ conflicted: false, changed: false });
  });

  it("detects a real conflict without aborting -- conflicted:true, names the file, and includes the conflict hunk text, leaving the worktree mid-merge for manual resolution", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0203");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0203", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "conflict.txt"), "branch version\n", "utf8");
    await commitAll({ worktreeDir, message: "feat: branch change" });

    const cloneDir = path.join(tmpDir, "other-clone-mergedevelop-conflict");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "conflict.txt"), "upstream version\n", "utf8");
    await git(["add", "conflict.txt"], cloneDir);
    await git(["commit", "-m", "upstream: conflicting change"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);

    await fetch({ worktreeDir });
    const result = await mergeDevelop({ worktreeDir, baseBranch: "develop" });

    expect(result.conflicted).toBe(true);
    expect(result.conflictedFiles).toEqual(["conflict.txt"]);
    expect(result.hunks["conflict.txt"]).toContain("<<<<<<<");
    expect(result.hunks["conflict.txt"]).toContain("branch version");
    expect(result.hunks["conflict.txt"]).toContain("upstream version");
    expect(result.hunks["conflict.txt"]).toContain(">>>>>>>");

    // Left mid-merge on purpose -- never auto-abort a real conflict, an agent resolves it in place.
    const { stdout: mergeHead } = await git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], worktreeDir).catch(
      (err) => ({ stdout: "", err })
    );
    expect(mergeHead.trim()).not.toBe("");
  });

  it("rejects (does not silently report conflicted) when the merge fails for a reason other than a content conflict", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0204");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0204", baseBranch: "develop" });

    await expect(mergeDevelop({ worktreeDir, baseBranch: "nonexistent-branch" })).rejects.toThrow(/git/i);
  });
});

describe("mergeStatus", () => {
  it("returns an empty array on a clean worktree", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0205");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0205", baseBranch: "develop" });

    await expect(mergeStatus({ worktreeDir })).resolves.toEqual([]);
  });

  it("lists unmerged files during an active conflicted merge, and clears once resolved and staged", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0206");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0206", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "conflict.txt"), "branch version\n", "utf8");
    await commitAll({ worktreeDir, message: "feat: branch change" });

    const cloneDir = path.join(tmpDir, "other-clone-mergestatus-conflict");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "conflict.txt"), "upstream version\n", "utf8");
    await git(["add", "conflict.txt"], cloneDir);
    await git(["commit", "-m", "upstream: conflicting change"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);

    await fetch({ worktreeDir });
    await mergeDevelop({ worktreeDir, baseBranch: "develop" });

    await expect(mergeStatus({ worktreeDir })).resolves.toEqual(["conflict.txt"]);

    await fs.writeFile(path.join(worktreeDir, "conflict.txt"), "resolved version\n", "utf8");
    await git(["add", "conflict.txt"], worktreeDir);

    await expect(mergeStatus({ worktreeDir })).resolves.toEqual([]);
  });
});

describe("abortMerge", () => {
  it("cleans a worktree left mid-merge (T-0291: a crashed conflict-resolution phase must not leave MERGE_HEAD/conflict markers on disk indefinitely)", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0207");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0207", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "conflict.txt"), "branch version\n", "utf8");
    await commitAll({ worktreeDir, message: "feat: branch change" });

    const cloneDir = path.join(tmpDir, "other-clone-abortmerge-conflict");
    await fs.mkdir(cloneDir, { recursive: true });
    await git(["clone", originDir, cloneDir]);
    await git(["config", "user.email", "test@example.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);
    await git(["checkout", "develop"], cloneDir);
    await fs.writeFile(path.join(cloneDir, "conflict.txt"), "upstream version\n", "utf8");
    await git(["add", "conflict.txt"], cloneDir);
    await git(["commit", "-m", "upstream: conflicting change"], cloneDir);
    await git(["push", "origin", "develop"], cloneDir);

    await fetch({ worktreeDir });
    const result = await mergeDevelop({ worktreeDir, baseBranch: "develop" });
    expect(result.conflicted).toBe(true);
    await expect(mergeStatus({ worktreeDir })).resolves.toEqual(["conflict.txt"]);

    await expect(abortMerge({ worktreeDir })).resolves.not.toThrow();

    await expect(mergeStatus({ worktreeDir })).resolves.toEqual([]);
    const { stdout: mergeHead } = await git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], worktreeDir).catch(
      (err) => ({ stdout: "", err })
    );
    expect(mergeHead.trim()).toBe("");
    const { stdout: status } = await git(["status", "--porcelain"], worktreeDir);
    expect(status.trim()).toBe("");
  });

  it("rejects when there is nothing to abort (no active merge) -- a caller must treat this as best-effort, not assume success", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0208");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0208", baseBranch: "develop" });

    await expect(abortMerge({ worktreeDir })).rejects.toThrow(/git/i);
  });
});

describe("commitPaths — auto-push", () => {
  it("pushes the commit to origin's develop by default (AUTO_PUSH_ON_COMMIT unset)", async () => {
    await fs.mkdir(path.join(repoRoot, "tasks"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tasks", "T-0030.md"), "card body\n", "utf8");

    await commitPaths({ repoRoot, filePaths: ["tasks/T-0030.md"], message: "chore(board): add card T-0030" });
    // schedulePush is fire-and-forget -- a real `git push` subprocess, whose completion time
    // varies with host load (T-0304 review: a full-suite run under load took longer than a
    // fixed 50ms sleep here, flaking this assertion). Poll instead of sleeping a fixed amount.
    await vi.waitFor(async () => {
      const { stdout: log } = await git(["log", "--oneline", "origin/develop"], repoRoot);
      expect(log).toContain("chore(board): add card T-0030");
    });
  });

  it("does not push when autoPush: false is passed", async () => {
    await fs.mkdir(path.join(repoRoot, "tasks"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tasks", "T-0031.md"), "card body\n", "utf8");

    await commitPaths({
      repoRoot,
      filePaths: ["tasks/T-0031.md"],
      message: "chore(board): add card T-0031",
      autoPush: false
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { stdout: log } = await git(["log", "--oneline", "origin/develop"], repoRoot);
    expect(log).not.toContain("chore(board): add card T-0031");
  });

  it("does not push when AUTO_PUSH_ON_COMMIT is disabled via env", async () => {
    const original = process.env.AUTO_PUSH_ON_COMMIT;
    process.env.AUTO_PUSH_ON_COMMIT = "0";
    try {
      await fs.mkdir(path.join(repoRoot, "tasks"), { recursive: true });
      await fs.writeFile(path.join(repoRoot, "tasks", "T-0032.md"), "card body\n", "utf8");

      await commitPaths({ repoRoot, filePaths: ["tasks/T-0032.md"], message: "chore(board): add card T-0032" });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const { stdout: log } = await git(["log", "--oneline", "origin/develop"], repoRoot);
      expect(log).not.toContain("chore(board): add card T-0032");
    } finally {
      if (original === undefined) delete process.env.AUTO_PUSH_ON_COMMIT;
      else process.env.AUTO_PUSH_ON_COMMIT = original;
    }
  });
});

describe("commitTaskFile", () => {
  it("stages and commits only the given card file, leaving other staged changes untouched", async () => {
    await fs.mkdir(path.join(repoRoot, "tasks"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tasks", "T-0010.md"), "card body\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "unrelated.txt"), "unrelated\n", "utf8");
    await git(["add", "unrelated.txt"], repoRoot);

    const committed = await commitTaskFile({
      repoRoot,
      filePath: "tasks/T-0010.md",
      message: "chore(board): add card T-0010",
      autoPush: false
    });

    expect(committed).toBe(true);
    const { stdout: log } = await git(["log", "-1", "--pretty=%s"], repoRoot);
    expect(log.trim()).toBe("chore(board): add card T-0010");
    const { stdout: statusAfter } = await git(["status", "--porcelain"], repoRoot);
    expect(statusAfter).toContain("A  unrelated.txt");
    expect(statusAfter).not.toContain("tasks/T-0010.md");
  });

  it("commits with the configured board author, independent of the ambient git identity", async () => {
    await fs.mkdir(path.join(repoRoot, "tasks"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tasks", "T-0011.md"), "card body\n", "utf8");

    await commitTaskFile({
      repoRoot,
      filePath: "tasks/T-0011.md",
      message: "chore(board): add card T-0011",
      autoPush: false
    });

    const { stdout: authorName } = await git(["log", "-1", "--pretty=%an"], repoRoot);
    const { stdout: authorEmail } = await git(["log", "-1", "--pretty=%ae"], repoRoot);
    expect(authorName.trim()).toBe("assembled-board");
    expect(authorEmail.trim()).toBe("board@localhost");
  });

  it("is a no-op and returns false when the file has no staged changes", async () => {
    await fs.mkdir(path.join(repoRoot, "tasks"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tasks", "T-0012.md"), "card body\n", "utf8");
    await commitTaskFile({
      repoRoot,
      filePath: "tasks/T-0012.md",
      message: "chore(board): add card T-0012",
      autoPush: false
    });

    const { stdout: before } = await git(["rev-parse", "HEAD"], repoRoot);
    const committed = await commitTaskFile({
      repoRoot,
      filePath: "tasks/T-0012.md",
      message: "chore(board): add card T-0012 (again)",
      autoPush: false
    });
    const { stdout: after } = await git(["rev-parse", "HEAD"], repoRoot);

    expect(committed).toBe(false);
    expect(after).toBe(before);
  });

  it("leaves the file tracked by git after commit", async () => {
    await fs.mkdir(path.join(repoRoot, "tasks"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tasks", "T-0013.md"), "card body\n", "utf8");

    await commitTaskFile({
      repoRoot,
      filePath: "tasks/T-0013.md",
      message: "chore(board): add card T-0013",
      autoPush: false
    });

    const { stdout: lsFiles } = await git(["ls-files", "tasks/T-0013.md"], repoRoot);
    expect(lsFiles.trim()).toBe("tasks/T-0013.md");
  });
});

describe("commitPaths", () => {
  it("stages and commits multiple paths in a single commit, leaving other staged changes untouched", async () => {
    await fs.mkdir(path.join(repoRoot, "tasks", "attachments", "T-0020"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tasks", "T-0020.md"), "card body\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "tasks", "attachments", "T-0020", "a.png"), "binary\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "unrelated.txt"), "unrelated\n", "utf8");
    await git(["add", "unrelated.txt"], repoRoot);

    const committed = await commitPaths({
      repoRoot,
      filePaths: ["tasks/T-0020.md", "tasks/attachments/T-0020/a.png"],
      message: "chore(board): attach a.png to card T-0020",
      autoPush: false
    });

    expect(committed).toBe(true);
    const { stdout: log } = await git(["log", "-1", "--pretty=%s"], repoRoot);
    expect(log.trim()).toBe("chore(board): attach a.png to card T-0020");
    const { stdout: lsFiles } = await git(["ls-files", "tasks/T-0020.md", "tasks/attachments/T-0020/a.png"], repoRoot);
    expect(lsFiles.trim().split("\n").sort()).toEqual(
      ["tasks/T-0020.md", "tasks/attachments/T-0020/a.png"].sort()
    );
    const { stdout: statusAfter } = await git(["status", "--porcelain"], repoRoot);
    expect(statusAfter).toContain("A  unrelated.txt");
  });

  it("stages a deleted path as a removal (git add -A), not silently ignoring it", async () => {
    await fs.mkdir(path.join(repoRoot, "tasks", "attachments", "T-0021"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tasks", "T-0021.md"), "card body\n", "utf8");
    const attachmentPath = path.join(repoRoot, "tasks", "attachments", "T-0021", "a.png");
    await fs.writeFile(attachmentPath, "binary\n", "utf8");
    await commitPaths({
      repoRoot,
      filePaths: ["tasks/T-0021.md", "tasks/attachments/T-0021/a.png"],
      message: "chore(board): attach a.png to card T-0021",
      autoPush: false
    });

    await fs.rm(attachmentPath);
    const committed = await commitPaths({
      repoRoot,
      filePaths: ["tasks/T-0021.md", "tasks/attachments/T-0021/a.png"],
      message: "chore(board): remove a.png from card T-0021",
      autoPush: false
    });

    expect(committed).toBe(true);
    const { stdout: lsFiles } = await git(["ls-files", "tasks/attachments/T-0021/a.png"], repoRoot);
    expect(lsFiles.trim()).toBe("");
  });

  it("is a no-op and returns false when none of the paths have staged changes", async () => {
    await fs.mkdir(path.join(repoRoot, "tasks"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tasks", "T-0022.md"), "card body\n", "utf8");
    await commitPaths({
      repoRoot,
      filePaths: ["tasks/T-0022.md"],
      message: "chore(board): add card T-0022",
      autoPush: false
    });

    const { stdout: before } = await git(["rev-parse", "HEAD"], repoRoot);
    const committed = await commitPaths({
      repoRoot,
      filePaths: ["tasks/T-0022.md"],
      message: "chore(board): add card T-0022 (again)",
      autoPush: false
    });
    const { stdout: after } = await git(["rev-parse", "HEAD"], repoRoot);

    expect(committed).toBe(false);
    expect(after).toBe(before);
  });
});

describe("linkBoardNodeModules", () => {
  it("creates a symlink at <worktreeDir>/tools/board/node_modules pointing to <repoRoot>/tools/board/node_modules", async () => {
    const src = path.join(repoRoot, "tools", "board", "node_modules");
    await fs.mkdir(src, { recursive: true });
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0137a");
    await fs.mkdir(path.join(worktreeDir, "tools", "board"), { recursive: true });

    await linkBoardNodeModules({ worktreeDir, repoRoot });

    const dest = path.join(worktreeDir, "tools", "board", "node_modules");
    const stat = await fs.lstat(dest);
    expect(stat.isSymbolicLink()).toBe(true);
    const target = await fs.readlink(dest);
    expect(target).toBe(src);
  });

  it("is idempotent — does not throw when the symlink already exists", async () => {
    const src = path.join(repoRoot, "tools", "board", "node_modules");
    await fs.mkdir(src, { recursive: true });
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0137b");
    await fs.mkdir(path.join(worktreeDir, "tools", "board"), { recursive: true });

    await linkBoardNodeModules({ worktreeDir, repoRoot });
    await expect(linkBoardNodeModules({ worktreeDir, repoRoot })).resolves.not.toThrow();
  });

  it("is a no-op when repoRoot/tools/board/node_modules does not exist", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0137c");
    await fs.mkdir(path.join(worktreeDir, "tools", "board"), { recursive: true });

    await expect(linkBoardNodeModules({ worktreeDir, repoRoot })).resolves.not.toThrow();

    const dest = path.join(worktreeDir, "tools", "board", "node_modules");
    await expect(fs.lstat(dest)).rejects.toThrow();
  });
});

describe("autoCommitCardsOnCreateFromEnv", () => {
  const original = process.env.AUTO_COMMIT_CARDS_ON_CREATE;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AUTO_COMMIT_CARDS_ON_CREATE;
    } else {
      process.env.AUTO_COMMIT_CARDS_ON_CREATE = original;
    }
  });

  it("defaults to true when unset", () => {
    delete process.env.AUTO_COMMIT_CARDS_ON_CREATE;
    expect(autoCommitCardsOnCreateFromEnv()).toBe(true);
  });

  it.each(["0", "false", "off", "no", "FALSE", "Off"])("is false when set to %s", (value) => {
    process.env.AUTO_COMMIT_CARDS_ON_CREATE = value;
    expect(autoCommitCardsOnCreateFromEnv()).toBe(false);
  });
});

describe("syncBaseBranch — the worktree base must be the code that is deployed", () => {
  /**
   * Advances origin/develop by one commit adding `filename`, while leaving repoRoot's local
   * `develop` ref exactly where it is -- the shape the live board was in on 2026-08-23.
   */
  async function advanceOriginDevelop(filename, cloneName = "publisher") {
    const publisher = path.join(tmpDir, cloneName);
    await git(["clone", "--branch", "develop", originDir, publisher]);
    await git(["config", "user.email", "test@example.com"], publisher);
    await git(["config", "user.name", "Test"], publisher);
    await fs.writeFile(path.join(publisher, filename), "shipped\n", "utf8");
    await git(["add", filename], publisher);
    await git(["commit", "-m", `add ${filename}`], publisher);
    await git(["push", "origin", "develop"], publisher);
    const { stdout } = await git(["rev-parse", "HEAD"], publisher);
    return stdout.trim();
  }

  it("fast-forwards a stale local develop while repoRoot sits on another branch", async () => {
    // repoRoot parked on a feature branch is exactly what froze `develop`: `pullDevelop` and
    // `isBehindOrigin` both operate on HEAD, so they report "up to date" and never touch the ref.
    await git(["checkout", "-b", "fix/parked"], repoRoot);
    const shipped = await advanceOriginDevelop("agentCurl.js");

    const before = await git(["rev-parse", "refs/heads/develop"], repoRoot);
    expect(before.stdout.trim()).not.toBe(shipped);

    const result = await syncBaseBranch({ repoRoot, branch: "develop" });

    expect(result.status).toBe("fast-forwarded");
    expect(result.after).toBe(shipped);
    const after = await git(["rev-parse", "refs/heads/develop"], repoRoot);
    expect(after.stdout.trim()).toBe(shipped);
    // The parked branch must not have been dragged along with it.
    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
    expect(head.stdout.trim()).toBe("fix/parked");
  });

  it("fast-forwards develop when develop is the branch repoRoot has checked out", async () => {
    const shipped = await advanceOriginDevelop("agentCurl.js", "publisher-checked-out");

    const result = await syncBaseBranch({ repoRoot, branch: "develop" });

    expect(result.status).toBe("fast-forwarded");
    const head = await git(["rev-parse", "HEAD"], repoRoot);
    expect(head.stdout.trim()).toBe(shipped);
  });

  it("reports 'current' and changes nothing when the ref already matches origin", async () => {
    const result = await syncBaseBranch({ repoRoot, branch: "develop" });
    expect(result.status).toBe("current");
    expect(result.before).toBe(result.after);
  });

  it("reports 'diverged' and leaves the ref alone rather than merging behind the caller's back", async () => {
    await advanceOriginDevelop("shipped.txt", "publisher-diverged");
    // Local develop now has its own commit too -- resolving that is pullDevelop's job, not ours.
    await fs.writeFile(path.join(repoRoot, "local-only.txt"), "local\n", "utf8");
    await git(["add", "local-only.txt"], repoRoot);
    await git(["commit", "-m", "local only"], repoRoot);
    const localTip = (await git(["rev-parse", "refs/heads/develop"], repoRoot)).stdout.trim();

    const result = await syncBaseBranch({ repoRoot, branch: "develop" });

    expect(result.status).toBe("diverged");
    expect((await git(["rev-parse", "refs/heads/develop"], repoRoot)).stdout.trim()).toBe(localTip);
  });

  it("degrades to 'unavailable' instead of throwing when origin cannot be reached", async () => {
    await git(["remote", "set-url", "origin", path.join(tmpDir, "no-such-remote.git")], repoRoot);

    const result = await syncBaseBranch({ repoRoot, branch: "develop" });

    expect(result.status).toBe("unavailable");
    expect(result.reason).toMatch(/fetch failed/);
  });
});

describe("addWorktree — cuts from the deployed tip, not a frozen local ref", () => {
  async function advanceOriginDevelop(filename, cloneName) {
    const publisher = path.join(tmpDir, cloneName);
    await git(["clone", "--branch", "develop", originDir, publisher]);
    await git(["config", "user.email", "test@example.com"], publisher);
    await git(["config", "user.name", "Test"], publisher);
    await fs.writeFile(path.join(publisher, filename), "shipped\n", "utf8");
    await git(["add", filename], publisher);
    await git(["commit", "-m", `add ${filename}`], publisher);
    await git(["push", "origin", "develop"], publisher);
  }

  it("gives the card a worktree containing code merged to develop moments earlier", async () => {
    // T-0218's failure, reduced: repoRoot on a feature branch, `develop` two days stale, and a
    // card cut from it missing tools/board/scripts/agentCurl.js -- the very file its grant named.
    await git(["checkout", "-b", "fix/parked"], repoRoot);
    await advanceOriginDevelop("agentCurl.js", "publisher-wt");

    const worktreeDir = path.join(tmpDir, "worktrees", "T-0218");
    const result = await addWorktree({
      repoRoot,
      worktreeDir,
      branch: "feature/T-0218",
      baseBranch: "develop"
    });

    expect(result.reused).toBe(false);
    expect(result.baseSync.status).toBe("fast-forwarded");
    await expect(fs.stat(path.join(worktreeDir, "agentCurl.js"))).resolves.toBeTruthy();
  });

  it("still cuts a worktree when the base cannot be synced", async () => {
    await git(["remote", "set-url", "origin", path.join(tmpDir, "no-such-remote.git")], repoRoot);

    const worktreeDir = path.join(tmpDir, "worktrees", "T-0219");
    const result = await addWorktree({
      repoRoot,
      worktreeDir,
      branch: "feature/T-0219",
      baseBranch: "develop"
    });

    expect(result.baseSync.status).toBe("unavailable");
    const stat = await fs.stat(worktreeDir);
    expect(stat.isDirectory()).toBe(true);
  });
});
