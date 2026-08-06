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
  pullDevelop,
  mergeNoFF,
  commitTaskFile,
  commitPaths,
  autoCommitCardsOnCreateFromEnv,
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

  it("reuses a branch with unique unpushed commits instead of destroying it, and reports reused: true", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0111");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0111", baseBranch: "develop" });
    await fs.writeFile(path.join(worktreeDir, "real-work.txt"), "important\n", "utf8");
    await commitAll({ worktreeDir, message: "feat: real work" });
    // Simulate the run dying after a real commit but before push -- must not be destroyed,
    // and a later addWorktree() for the same card (e.g. a re-run after review) continues on it.
    await removeWorktree({ repoRoot, worktreeDir });

    const result = await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0111", baseBranch: "develop" });

    expect(result).toEqual({ reused: true });
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

    expect(result).toEqual({ reused: true });
    const { stdout: log } = await git(["log", "-1", "--pretty=%s"], worktreeDir);
    expect(log.trim()).toBe("feat: real work");
  });

  it("leaves normal (non-stale) worktree creation unchanged and reports reused: false", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0199");
    const result = await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0199", baseBranch: "develop" });

    expect(result).toEqual({ reused: false });
    const stat = await fs.stat(worktreeDir);
    expect(stat.isDirectory()).toBe(true);
    const { stdout: branch } = await git(["rev-parse", "--abbrev-ref", "HEAD"], worktreeDir);
    expect(branch.trim()).toBe("feature/T-0199");
  });

  it("reports reused: false when a stale branch with no unique commits is discarded", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0100b");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0100b", baseBranch: "develop" });

    const result = await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0100b", baseBranch: "develop" });

    expect(result).toEqual({ reused: false });
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
});

describe("mergeNoFF", () => {
  it("fetches and merges origin/<branch> with --no-ff, producing a merge commit", async () => {
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
    expect(parents.trim().split(" ").length).toBe(2); // merge commit has two parents
  });

  it("merges cleanly (no-op merge commit) when already up to date", async () => {
    await expect(mergeNoFF({ repoRoot, branch: "develop" })).resolves.not.toThrow();
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

describe("commitPaths — auto-push", () => {
  it("pushes the commit to origin's develop by default (AUTO_PUSH_ON_COMMIT unset)", async () => {
    await fs.mkdir(path.join(repoRoot, "tasks"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tasks", "T-0030.md"), "card body\n", "utf8");

    await commitPaths({ repoRoot, filePaths: ["tasks/T-0030.md"], message: "chore(board): add card T-0030" });
    // schedulePush is fire-and-forget -- give its microtask chain a tick to actually run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { stdout: log } = await git(["log", "--oneline", "origin/develop"], repoRoot);
    expect(log).toContain("chore(board): add card T-0030");
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
