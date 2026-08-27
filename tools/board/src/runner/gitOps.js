import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { schedulePush } from "./autoPush.js";

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
 * A dead/killed run -- or a card sent back for another pass after review -- can leave
 * `feature/T-XXXX` (and its worktree) behind, which makes every future addWorktree() for
 * that card fail on "branch already exists". A leftover branch with no commits beyond
 * baseBranch -- whether it never diverged or has since been merged -- is safe to discard
 * and retry fresh. One with real unique commits is real work (see T-0111): rather than
 * destroying it, reattach a worktree to the existing branch so the run continues on top of
 * it instead of starting over.
 */
async function reclaimOrDetectExisting({ repoRoot, worktreeDir, branch, baseBranch }) {
  if (!(await branchExists({ repoRoot, branch }))) {
    return false;
  }
  if (await pathExists(worktreeDir)) {
    try {
      await git(["worktree", "remove", "--force", worktreeDir], repoRoot);
    } catch {
      // administrative entry may already be broken (e.g. dir removed out-of-band); prune below clears it
    }
    await git(["worktree", "prune"], repoRoot);
  }
  if (!(await branchHasUniqueCommits({ repoRoot, branch, baseBranch }))) {
    await git(["branch", "-D", branch], repoRoot);
    return false;
  }
  return true;
}

async function revParse({ repoRoot, ref }) {
  try {
    const { stdout } = await git(["rev-parse", "--verify", "--quiet", ref], repoRoot);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** The branch repoRoot itself has checked out, or null when it is on a detached HEAD. */
async function currentBranch({ repoRoot }) {
  try {
    const { stdout } = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], repoRoot);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Whether some worktree *other than repoRoot* has `branch` checked out. Moving a ref out from
 * under a checked-out worktree desyncs its index against HEAD, so that case is reported rather
 * than forced.
 */
async function branchCheckedOutElsewhere({ repoRoot, branch }) {
  const { stdout } = await git(["worktree", "list", "--porcelain"], repoRoot);
  return stdout.split(/\n\s*\n/).some((entry) => {
    const dir = /^worktree (.*)$/m.exec(entry)?.[1];
    const head = /^branch (.*)$/m.exec(entry)?.[1];
    return head === `refs/heads/${branch}` && dir && path.resolve(dir) !== path.resolve(repoRoot);
  });
}

/**
 * Fast-forwards repoRoot's local `<branch>` ref to origin's, so that whatever is cut from it
 * next is the code that is actually deployed.
 *
 * Why this is needed at all: `addWorktree` cuts every card branch from the *local* `develop`
 * ref, and nothing in the board reliably advances that ref. `pullDevelop` and `mergeNoFF` both
 * act on repoRoot's *checked-out* branch, and `isBehindOrigin` compares `HEAD..origin/develop`
 * -- so a repoRoot parked on any other branch (a deploy or a hotfix left on `fix/...`, say)
 * keeps reporting "up to date" while `refs/heads/develop` silently stays wherever it was.
 *
 * That is not hypothetical. On 2026-08-23 the live board started T-0218 five minutes after PR
 * #240 merged: repoRoot's checkout was at #240's code -- so the runner read #240's agent
 * definitions and emitted its grants -- while `develop` was still at PR #221 from two days
 * earlier. #240 had replaced the `assets`/`audio` blanket `Bash(curl:*)` with
 * `Bash(node tools/board/scripts/agentCurl.js:*)`, and the worktree cut from the frozen ref did
 * not contain that file: "Cannot find module .../worktrees/T-0218/tools/board/scripts/
 * agentCurl.js". The card had no HTTP client at all and burned all five auto-retries reporting
 * ComfyUI unreachable.
 *
 * Deliberately non-throwing. A fetch failure (offline, no origin, a fixture repo with no
 * remote) degrades to "cut from whatever the local ref is" -- exactly the previous behaviour --
 * rather than stopping every run on the board. Divergence is likewise reported, never resolved:
 * merging is `pullDevelop`'s job, and doing it silently here could rewrite work.
 *
 * @returns {Promise<{status: "current"|"fast-forwarded"|"created"|"diverged"|"checked-out-elsewhere"|"unavailable",
 *                    before: string|null, after: string|null, reason: string|null}>}
 */
export async function syncBaseBranch({ repoRoot, branch = "develop" }) {
  const before = await revParse({ repoRoot, ref: `refs/heads/${branch}` });
  const unchanged = (status, reason) => ({ status, before, after: before, reason });

  try {
    await git(["fetch", "origin", branch], repoRoot);
  } catch (err) {
    return unchanged("unavailable", `fetch failed: ${err.message}`);
  }

  const originSha = await revParse({ repoRoot, ref: `refs/remotes/origin/${branch}` });
  if (!originSha) {
    return unchanged("unavailable", `origin/${branch} could not be resolved after fetch`);
  }
  if (before === originSha) {
    return { status: "current", before, after: originSha, reason: null };
  }

  if (before !== null) {
    const { stdout } = await git(
      ["rev-list", "--count", `${originSha}..refs/heads/${branch}`],
      repoRoot
    );
    if (Number(stdout.trim()) > 0) {
      return unchanged(
        "diverged",
        `local ${branch} has commits origin/${branch} does not; leaving it for pullDevelop to reconcile`
      );
    }
  }

  if ((await currentBranch({ repoRoot })) === branch) {
    try {
      await git(["merge", "--ff-only", `origin/${branch}`], repoRoot);
    } catch (err) {
      return unchanged("unavailable", `fast-forward of checked-out ${branch} failed: ${err.message}`);
    }
  } else if (await branchCheckedOutElsewhere({ repoRoot, branch })) {
    return unchanged(
      "checked-out-elsewhere",
      `${branch} is checked out in another worktree; not moving its ref`
    );
  } else {
    await git(["update-ref", `refs/heads/${branch}`, originSha], repoRoot);
  }

  return {
    status: before === null ? "created" : "fast-forwarded",
    before,
    after: originSha,
    reason: null
  };
}

/**
 * Creates a worktree for a card. If `branch` already exists with unique commits ahead of
 * baseBranch (a card being continued after review, or a resumed crashed run), reattaches a
 * worktree to that existing branch instead of cutting a fresh one -- returns `{ reused: true }`
 * so the caller can prompt the implementer to fix outstanding issues rather than start over.
 * Otherwise cuts a new branch from baseBranch as before -- returns `{ reused: false }`.
 *
 * baseBranch is fast-forwarded to origin first (see `syncBaseBranch`); the resulting
 * `{ baseSync }` says whether that succeeded, so a run cut from a lagging base is at least
 * visible rather than silent.
 */
export async function addWorktree({ repoRoot, worktreeDir, branch, baseBranch = "develop" }) {
  const baseSync = await syncBaseBranch({ repoRoot, branch: baseBranch });
  if (baseSync.status !== "current" && baseSync.status !== "fast-forwarded" && baseSync.status !== "created") {
    // Not fatal -- the worktree is still cut, just from a base that may lag origin. Loud,
    // because a card silently running against stale code is what T-0218 spent five attempts on.
    console.warn(
      `Board: ${baseBranch} was not synced to origin before cutting ${branch} (${baseSync.status}): ${baseSync.reason}`
    );
  }
  const reused = await reclaimOrDetectExisting({ repoRoot, worktreeDir, branch, baseBranch });
  if (reused) {
    await git(["worktree", "add", worktreeDir, branch], repoRoot);
  } else {
    await git(["worktree", "add", "-b", branch, worktreeDir, baseBranch], repoRoot);
  }
  return { reused, baseSync };
}

/** Force-removes a worktree, even if it has uncommitted changes. Never deletes the branch. */
export async function removeWorktree({ repoRoot, worktreeDir }) {
  await git(["worktree", "remove", "--force", worktreeDir], repoRoot);
}

export async function hasUncommittedChanges({ worktreeDir }) {
  const { stdout } = await git(["status", "--porcelain"], worktreeDir);
  return stdout.trim().length > 0;
}

/**
 * Stages and commits every change in the worktree. Returns false (no-op) if there's nothing to
 * commit -- the empty-worktree guard that keeps callers (e.g. the orchestrator's post-implementer
 * capture safety net) from ever creating an empty commit. `author`, when given, commits with that
 * identity (via `-c user.name=/-c user.email=`) instead of the ambient git config -- for commits
 * the board tool makes on an agent's behalf, not authored by the agent itself.
 */
export async function commitAll({ worktreeDir, message, author }) {
  if (!(await hasUncommittedChanges({ worktreeDir }))) {
    return false;
  }
  await git(["add", "-A"], worktreeDir);
  const commitArgs = author
    ? ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", message]
    : ["commit", "-m", message];
  await git(commitArgs, worktreeDir);
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

/**
 * Pushes `branch` to origin. `force: true` uses `--force-with-lease` -- needed when
 * continuing a card whose worktree was reattached to an existing branch (see addWorktree's
 * `reused` case) and the implementer's new commits don't fast-forward from what's already
 * on origin (e.g. an amended commit). `--force-with-lease` still refuses to overwrite a
 * remote that moved in some way we didn't expect, unlike a bare `--force`.
 */
export async function push({ worktreeDir, branch, force = false }) {
  const args = force ? ["push", "--force-with-lease", "-u", "origin", branch] : ["push", "-u", "origin", branch];
  await git(args, worktreeDir);
}

/** Full SHA of the worktree's current HEAD, for persisting review metadata on a card. */
export async function getHeadCommit({ worktreeDir }) {
  const { stdout } = await git(["rev-parse", "HEAD"], worktreeDir);
  return stdout.trim();
}

/**
 * A deterministic snapshot of what a worktree currently holds: `{ head, tree, dirty }`.
 *
 * - `head`  -- the HEAD commit sha
 * - `tree`  -- HEAD's tree object sha, so two different commits with identical content (a
 *              reworded or re-authored commit) still compare equal on content
 * - `dirty` -- `git status --porcelain`, catching staged/unstaged/untracked work that has not
 *              been committed yet
 *
 * This is the basis for the retry loop's no-progress signature (failureSignature.js): if all
 * three are unchanged across two attempts, the attempt left nothing behind and retrying it again
 * cannot help. Ignored files are deliberately excluded -- `--porcelain` without `--ignored` --
 * because the reviewer judges committed/tracked deliverables, and pulling in ignored build
 * output would make the signature churn on noise the gate does not care about.
 */
export async function readTreeState({ worktreeDir }) {
  const [head, tree, status] = await Promise.all([
    git(["rev-parse", "HEAD"], worktreeDir),
    git(["rev-parse", "HEAD^{tree}"], worktreeDir),
    git(["status", "--porcelain"], worktreeDir)
  ]);
  return {
    head: head.stdout.trim(),
    tree: tree.stdout.trim(),
    dirty: status.stdout.trim()
  };
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
 * conflict-free in practice -- but not guaranteed conflict-free (two runs touching the same
 * card, or a card reworked on both sides, are real cases), so on failure this runs `merge
 * --abort` before rethrowing, the same as `mergeNoFF` below: a caller that only logs the
 * error (as the Done-triggered call in httpApi.js does) must never be left with repoRoot mid-
 * merge -- conflict markers on disk block every subsequent commit and pull until someone
 * resolves it by hand.
 */
export async function pullDevelop({ repoRoot, branch = "develop" }) {
  const { stdout: beforeOut } = await git(["rev-parse", "HEAD"], repoRoot);
  const before = beforeOut.trim();
  try {
    await git(["pull", "--no-rebase", "--no-edit", "origin", branch], repoRoot);
  } catch (err) {
    await git(["merge", "--abort"], repoRoot).catch(() => {
      // Best-effort cleanup -- if there was nothing to abort (e.g. the pull failed before a
      // merge ever started, such as the branch-doesn't-exist case), that's fine; the original
      // error below is what matters to the caller.
    });
    throw err;
  }
  const { stdout: afterOut } = await git(["rev-parse", "HEAD"], repoRoot);
  const after = afterOut.trim();
  return { advanced: before !== after, before, after };
}

/**
 * Fetches `branch` from origin and reports whether origin has commits repoRoot's HEAD doesn't
 * have yet -- the cheap check the periodic auto-pull poller (autoPullPoller.js) runs every tick
 * before deciding whether `pullDevelop` is worth invoking at all. Deliberately a `rev-list
 * --count HEAD..origin/<branch>` (commits reachable from origin not reachable from HEAD), not a
 * plain SHA inequality check: repoRoot can be locally ahead of origin on its own (e.g. a
 * card-on-create commit that hasn't been auto-pushed yet, see `commitPaths`), and that alone is
 * not "behind" -- there's nothing new to pull. A truly diverged history (local ahead AND origin
 * ahead) still correctly reports true here, since `pullDevelop`'s merge is what's needed to
 * reconcile it.
 */
export async function isBehindOrigin({ repoRoot, branch = "develop" }) {
  await git(["fetch", "origin", branch], repoRoot);
  const { stdout } = await git(["rev-list", "--count", `HEAD..origin/${branch}`], repoRoot);
  return Number(stdout.trim()) > 0;
}

/**
 * Fetches `branch` from origin and merges `origin/<branch>` into repoRoot's checkout with
 * `--no-ff` -- always a real merge commit, even on the (common, for a repo whose local
 * `develop` never diverges from origin) case where a plain fast-forward would apply. Used
 * both by the deploy script's pre-restart sync step and by the auto-push retry path
 * (`autoPush.js`) to reconcile before retrying a rejected push.
 *
 * On conflict, runs `merge --abort` before rethrowing -- the caller gets a clean, mergeable
 * working tree back either way, never one left mid-merge with conflict markers on disk. That
 * property is what lets the deploy script "abort loudly" instead of leaving a broken tree for
 * `node --watch` (or the next deploy attempt) to trip over.
 */
export async function mergeNoFF({ repoRoot, branch = "develop" }) {
  await git(["fetch", "origin", branch], repoRoot);
  try {
    await git(["merge", "--no-ff", "--no-edit", `origin/${branch}`], repoRoot);
  } catch (err) {
    await git(["merge", "--abort"], repoRoot).catch(() => {
      // Best-effort cleanup -- if there was nothing to abort (e.g. the fetch/ref-resolution
      // itself failed before a merge ever started), that's fine; the original error below is
      // what matters to the caller.
    });
    throw err;
  }
}

/** Fetches `origin` into a card worktree, updating its remote-tracking refs without touching the working tree or branch. */
export async function fetch({ worktreeDir }) {
  await git(["fetch", "origin"], worktreeDir);
}

/**
 * Merges `origin/<baseBranch>` into a card worktree's current branch -- the "merge develop into
 * my PR branch" enforcement step run right after a PR is opened (see runOrchestrator.js's
 * `_syncBranchWithDevelop`). Unlike `mergeNoFF`/`pullDevelop`, a real content conflict is
 * **never** auto-aborted: this always leaves the worktree exactly as `git merge` left it (mid-
 * merge, conflict markers on disk, `MERGE_HEAD` present) so the owning agent can resolve it in
 * place, rather than throwing the state away for a caller to retry blind.
 *
 * Returns `{ conflicted: false, changed }` on a clean merge (`changed` is false when the branch
 * already contained everything on `origin/<baseBranch>` -- nothing to commit or push), or
 * `{ conflicted: true, conflictedFiles, hunks }` when `git merge` stops on real conflicts --
 * `hunks` maps each conflicted file's relative path to its on-disk conflict-marked content
 * (`<<<<<<<`/`=======`/`>>>>>>>`), the same text an agent would see resolving it by hand, so the
 * conflict-resolution prompt can be built from it directly without a second round trip.
 *
 * A merge failure that leaves no unmerged paths (`baseBranch` doesn't exist on origin, `git
 * merge` itself errored before touching the tree) is not a conflict -- it rethrows instead of
 * misreporting `conflicted: true` for something no amount of manual resolution would fix.
 */
export async function mergeDevelop({ worktreeDir, baseBranch = "develop" }) {
  const { stdout: beforeOut } = await git(["rev-parse", "HEAD"], worktreeDir);
  const before = beforeOut.trim();

  try {
    await git(["merge", "--no-edit", `origin/${baseBranch}`], worktreeDir);
  } catch (err) {
    const conflictedFiles = await mergeStatus({ worktreeDir });
    if (conflictedFiles.length === 0) {
      throw err;
    }
    const hunks = {};
    for (const file of conflictedFiles) {
      hunks[file] = await fs.readFile(path.join(worktreeDir, file), "utf8").catch(() => "");
    }
    return { conflicted: true, conflictedFiles, hunks };
  }

  const { stdout: afterOut } = await git(["rev-parse", "HEAD"], worktreeDir);
  const after = afterOut.trim();
  return { conflicted: false, changed: before !== after };
}

/** Relative paths of any currently-unmerged (conflicted) files in a worktree; empty once every conflict is resolved and staged. */
export async function mergeStatus({ worktreeDir }) {
  const { stdout } = await git(["diff", "--name-only", "--diff-filter=U"], worktreeDir);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Identity for commits the board tool makes on an agent's behalf rather than authored by the agent (see `commitAll`'s `author` param and `commitTaskFile`). */
export const BOARD_COMMIT_AUTHOR = { name: "assembled-board", email: "board@localhost" };
const AUTO_COMMIT_DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** AUTO_COMMIT_CARDS_ON_CREATE env var: default ON; set to "0"/"false"/"off"/"no" (any case) to disable committing card files as they're written. */
export function autoCommitCardsOnCreateFromEnv() {
  return !AUTO_COMMIT_DISABLE_VALUES.has((process.env.AUTO_COMMIT_CARDS_ON_CREATE ?? "").toLowerCase());
}

/**
 * Stages and commits one or more paths (relative to repoRoot) so they become part of tracked
 * history immediately, instead of sitting as untracked local state that a branch cut from
 * origin (or a sibling worktree started before this moment) can never see -- the root cause of
 * card-ID reuse this pairs with the git-aware `IdAllocator`. Scoped to `filePaths` via `commit
 * --` pathspec so it can never accidentally sweep up unrelated staged changes in repoRoot.
 * Uses `add -A` (not plain `add`) so a path that was deleted from the working tree -- e.g. an
 * attachment removed from disk -- is staged as a deletion rather than silently ignored. Returns
 * false (no-op) if nothing actually changed across those paths.
 *
 * On a real commit, also schedules an async push of `pushBranch` (default "develop") to origin
 * -- see `autoPush.js`. This is the single choke point every board-authored runtime commit goes
 * through (card create, comments, attachments), so wiring it in here means every caller gets
 * auto-push for free with zero changes at the call sites -- deliberately, so origin stops
 * drifting from repoRoot's `develop` without having to touch each route handler (notably the
 * attachment routes) individually. Pass `autoPush: false` to opt a specific call out; the
 * `AUTO_PUSH_ON_COMMIT` env var (see `autoPushOnCommitFromEnv`) is the global on/off switch.
 */
export async function commitPaths({
  repoRoot,
  filePaths,
  message,
  author = BOARD_COMMIT_AUTHOR,
  autoPush = true,
  pushBranch = "develop",
  logger = console
}) {
  await git(["add", "-A", "--", ...filePaths], repoRoot);
  try {
    await git(["diff", "--cached", "--quiet", "--", ...filePaths], repoRoot);
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
      ...filePaths
    ],
    repoRoot
  );
  if (autoPush) {
    schedulePush({ repoRoot, branch: pushBranch, git: { push, mergeNoFF }, logger });
  }
  return true;
}

/** Single-path convenience wrapper around `commitPaths` (see its docstring, including the auto-push behavior). */
export async function commitTaskFile({
  repoRoot,
  filePath,
  message,
  author = BOARD_COMMIT_AUTHOR,
  autoPush = true,
  pushBranch = "develop",
  logger = console
}) {
  return commitPaths({ repoRoot, filePaths: [filePath], message, author, autoPush, pushBranch, logger });
}

/**
 * Creates a symlink at `<worktreeDir>/tools/board/node_modules` pointing to
 * `<repoRoot>/tools/board/node_modules` so that verification agents can run
 * `npm test` in a fresh worktree without first running `npm install`.
 *
 * Best-effort: if the source doesn't exist yet (e.g. the main worktree hasn't
 * had `npm install` run yet) the call silently returns without creating the link.
 * Idempotent: if the destination already exists (symlink or real dir) it returns
 * without error.
 */
export async function linkBoardNodeModules({ worktreeDir, repoRoot }) {
  const src = path.join(repoRoot, "tools", "board", "node_modules");
  const dest = path.join(worktreeDir, "tools", "board", "node_modules");

  try {
    await fs.stat(src);
  } catch {
    return;
  }

  try {
    await fs.lstat(dest);
    return;
  } catch {
    // dest doesn't exist — proceed to create symlink
  }

  await fs.symlink(src, dest);
}
