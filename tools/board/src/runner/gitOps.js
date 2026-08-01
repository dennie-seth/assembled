import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  try {
    return await execFileAsync("git", args, { cwd });
  } catch (err) {
    throw new Error(`git ${args.join(" ")} failed: ${err.stderr || err.message}`);
  }
}

/** Creates a worktree for a card on a new branch cut from baseBranch (develop). */
export async function addWorktree({ repoRoot, worktreeDir, branch, baseBranch = "develop" }) {
  await git(["worktree", "add", "-b", branch, worktreeDir, baseBranch], repoRoot);
}

/** Force-removes a worktree, even if it has uncommitted changes. Never deletes the branch. */
export async function removeWorktree({ repoRoot, worktreeDir }) {
  await git(["worktree", "remove", "--force", worktreeDir], repoRoot);
}

export async function hasUncommittedChanges({ worktreeDir }) {
  const { stdout } = await git(["status", "--porcelain"], worktreeDir);
  return stdout.trim().length > 0;
}

/** Stages and commits every change in the worktree. Returns false (no-op) if there's nothing to commit. */
export async function commitAll({ worktreeDir, message }) {
  if (!(await hasUncommittedChanges({ worktreeDir }))) {
    return false;
  }
  await git(["add", "-A"], worktreeDir);
  await git(["commit", "-m", message], worktreeDir);
  return true;
}

/** File paths changed relative to baseBranch (develop), for reviewer path-rule resolution. */
export async function diffNames({ worktreeDir, baseBranch = "develop" }) {
  const { stdout } = await git(["diff", `${baseBranch}...HEAD`, "--name-only"], worktreeDir);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function push({ worktreeDir, branch }) {
  await git(["push", "-u", "origin", branch], worktreeDir);
}
