import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  pullDevelop
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
  await fs.rm(tmpDir, { recursive: true, force: true });
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

  it("blocks with a clear, branch-naming message and preserves everything when the stale branch has unique unpushed commits", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0111");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0111", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "real-work.txt"), "important\n", "utf8");
    await commitAll({ worktreeDir, message: "feat: real work" });
    // Simulate the run dying after a real commit but before push -- must not be destroyed.

    await expect(
      addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0111", baseBranch: "develop" })
    ).rejects.toThrow(/feature\/T-0111/);
    await expect(
      addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0111", baseBranch: "develop" })
    ).rejects.toThrow(/unpushed/i);

    const { stdout: branchSha } = await git(["rev-parse", "feature/T-0111"], repoRoot);
    expect(branchSha.trim().length).toBe(40);
    const stat = await fs.stat(worktreeDir);
    expect(stat.isDirectory()).toBe(true);
    const { stdout: log } = await git(["log", "-1", "--pretty=%s"], worktreeDir);
    expect(log.trim()).toBe("feat: real work");
    const { stdout: list } = await git(["worktree", "list"], repoRoot);
    expect(list).toContain(worktreeDir);
  });

  it("leaves normal (non-stale) worktree creation unchanged", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0199");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0199", baseBranch: "develop" });

    const stat = await fs.stat(worktreeDir);
    expect(stat.isDirectory()).toBe(true);
    const { stdout: branch } = await git(["rev-parse", "--abbrev-ref", "HEAD"], worktreeDir);
    expect(branch.trim()).toBe("feature/T-0199");
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
});

describe("pullDevelop", () => {
  it("fast-forwards develop when origin has new commits", async () => {
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
  });

  it("resolves without error when develop is already up to date", async () => {
    await expect(pullDevelop({ repoRoot, branch: "develop" })).resolves.not.toThrow();
  });

  it("rejects with a descriptive error when the branch does not exist on origin", async () => {
    await expect(pullDevelop({ repoRoot, branch: "nonexistent-branch" })).rejects.toThrow(
      /nonexistent-branch|git pull/i
    );
  });
});
