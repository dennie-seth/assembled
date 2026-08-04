import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  try {
    return await execFileAsync("git", args, { cwd });
  } catch (err) {
    throw new Error(`git ${args.join(" ")} failed: ${err.stderr || err.message}`);
  }
}

async function pathExists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function branchExists({ repoRoot, branch }) {
  try {
    await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

async function branchHasUniqueCommits({ repoRoot, branch, baseBranch }) {
  const { stdout } = await git(["rev-list", `${baseBranch}..${branch}`], repoRoot);
  return stdout.trim().length > 0;
}

/**
 * A dead/killed run can leave `feature/T-XXXX` (and its worktree) behind, which makes
 * every future addWorktree() for that card fail on "branch already exists". A leftover
 * branch with no commits beyond baseBranch -- whether it never diverged or has since been
 * merged -- is safe to discard and retry. One with real unpushed commits is not: block
 * instead so real work (see T-0111) never gets silently destroyed.
 */
async function reclaimStaleBranch({ repoRoot, worktreeDir, branch, baseBranch }) {
  if (!(await branchExists({ repoRoot, branch }))) {
    return;
  }
  if (await branchHasUniqueCommits({ repoRoot, branch, baseBranch })) {
    throw new Error(
      `branch '${branch}' already exists with unpushed commits not in ${baseBranch} -- looks like real work left over ` +
        `from a previous run. Push it, cherry-pick what you need, or delete it yourself (git branch -D ${branch}) before retrying.`
    );
  }
  if (await pathExists(worktreeDir)) {
    try {
      await git(["worktree", "remove", "--force", worktreeDir], repoRoot);
    } catch {
      // administrative entry may already be broken (e.g. dir removed out-of-band); prune below clears it
    }
  }
  await git(["worktree", "prune"], repoRoot);
  await git(["branch", "-D", branch], repoRoot);
}

/** Creates a worktree for a card on a new branch cut from baseBranch (develop). */
export async function addWorktree({ repoRoot, worktreeDir, branch, baseBranch = "develop" }) {
  await reclaimStaleBranch({ repoRoot, worktreeDir, branch, baseBranch });
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

/** Full SHA of the worktree's current HEAD, for persisting review metadata on a card. */
export async function getHeadCommit({ worktreeDir }) {
  const { stdout } = await git(["rev-parse", "HEAD"], worktreeDir);
  return stdout.trim();
}

/**
 * Pulls the latest commits for `branch` (default "develop") into repoRoot from origin. Reports
 * whether HEAD moved, so callers know whether there's new code to pick up.
 *
 * `--no-rebase --no-edit` are explicit rather than relying on ambient git config: card-on-create
 * commits (see `commitTaskFile`) can leave repoRoot's local branch with commits origin doesn't
 * have yet, and a `pull.ff=only` or `pull.rebase=true` global default would otherwise turn a
 * perfectly normal divergence into a failed/rewritten pull. A plain three-way merge is what we
 * want here: it's predictable and, since card files are new/unique paths, essentially
 * conflict-free in practice.
 */
export async function pullDevelop({ repoRoot, branch = "develop" }) {
  const { stdout: beforeOut } = await git(["rev-parse", "HEAD"], repoRoot);
  const before = beforeOut.trim();
  await git(["pull", "--no-rebase", "--no-edit", "origin", branch], repoRoot);
  const { stdout: afterOut } = await git(["rev-parse", "HEAD"], repoRoot);
  const after = afterOut.trim();
  return { advanced: before !== after, before, after };
}

const CARD_COMMIT_AUTHOR = { name: "assembled-board", email: "board@localhost" };
const AUTO_COMMIT_DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** AUTO_COMMIT_CARDS_ON_CREATE env var: default ON; set to "0"/"false"/"off"/"no" (any case) to disable committing card files as they're written. */
export function autoCommitCardsOnCreateFromEnv() {
  return !AUTO_COMMIT_DISABLE_VALUES.has((process.env.AUTO_COMMIT_CARDS_ON_CREATE ?? "").toLowerCase());
}

/**
 * Stages and commits a single card file (relative to repoRoot) so it becomes part of tracked
 * history immediately, instead of sitting as untracked local state that a branch cut from
 * origin (or a sibling worktree started before this moment) can never see -- the root cause of
 * card-ID reuse this pairs with the git-aware `IdAllocator`. Scoped to `filePath` via `commit
 * --` pathspec so it can never accidentally sweep up unrelated staged changes in repoRoot.
 * Returns false (no-op) if nothing actually changed for that path.
 */
export async function commitTaskFile({ repoRoot, filePath, message, author = CARD_COMMIT_AUTHOR }) {
  await git(["add", "--", filePath], repoRoot);
  try {
    await git(["diff", "--cached", "--quiet", "--", filePath], repoRoot);
    return false;
  } catch {
    // non-zero exit from `diff --quiet` means there IS a staged change -- fall through to commit.
  }
  await git(
    [
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      "commit",
      "-m",
      message,
      "--",
      filePath
    ],
    repoRoot
  );
  return true;
}
