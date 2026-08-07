import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseTask, serializeTask } from "../lib/taskParser.js";
import { checkPlannerDiffGuard } from "../lib/plannerDiffGuard.js";

const execFileAsync = promisify(execFile);

const MUTABLE_FIELDS = ["title", "priority", "phase", "agent", "depends_on", "created", "deliverable_type", "body"];

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

async function isGitRepo(worktreeDir) {
  try {
    await git(["rev-parse", "--git-dir"], worktreeDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the git-internal path for `relPath` (e.g. "info/exclude") the way that's correct for
 * *this* worktree specifically -- `git rev-parse --git-path` accounts for the difference between
 * a linked worktree's own `.git/worktrees/<name>/` dir and the main checkout's `.git/`, so this
 * never needs to hand-parse the worktree's `.git` file itself.
 */
async function gitPath(worktreeDir, relPath) {
  const { stdout } = await git(["rev-parse", "--git-path", relPath], worktreeDir);
  return path.resolve(worktreeDir, stdout.trim());
}

/** Adds `/tasks/` to this worktree's own `info/exclude` (never the tracked `.gitignore`, which would affect every other worktree/branch, including fs-mode ones), idempotently. */
async function addTasksToExclude(worktreeDir) {
  const excludePath = await gitPath(worktreeDir, "info/exclude");
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  let content = "";
  try {
    content = await fs.readFile(excludePath, "utf8");
  } catch {
    // no exclude file yet -- start fresh
  }
  if (!content.split("\n").includes("/tasks/")) {
    const sep = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    await fs.writeFile(excludePath, `${content}${sep}/tasks/\n`, "utf8");
  }
}

/**
 * Makes `<worktreeDir>/tasks/` fully invisible to git for the duration of the planner phase.
 *
 * Two cases, handled differently on purpose:
 * - Paths already tracked there (this repo's Phase 2 dual-track window: `tasks/` is still
 *   git-tracked from `develop` even though this run is in db mode) get
 *   `git update-index --skip-worktree` -- git stops comparing their working-tree content
 *   against the index at all, so overwriting them with DB content produces neither a staged nor
 *   an unstaged diff. This is deliberately NOT `git rm --cached`: that leaves a *staged
 *   deletion* sitting in the index until something un-stages it, which a bare `git commit` (the
 *   planner's own documented workflow step) would happily include -- silently deleting the
 *   original card file from the branch's history the moment the planner commits anything.
 *   `--skip-worktree` has no such side effect.
 * - Genuinely new paths (a split-off card the planner creates) are covered by this worktree's
 *   own `info/exclude`, so `git add -A` skips them like any other ignored file.
 *
 * Returns the list of paths that were skip-worktree'd, so `unhideTasksDirFromGit` can reverse
 * exactly those. Best-effort: returns `[]` for a worktreeDir that isn't a real git repo (unit
 * tests) -- materialization still works as a plain filesystem operation either way.
 */
async function hideTasksDirFromGit(worktreeDir) {
  if (!(await isGitRepo(worktreeDir))) return [];
  try {
    await addTasksToExclude(worktreeDir);
    const { stdout } = await git(["ls-files", "--", "tasks"], worktreeDir);
    const tracked = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (tracked.length > 0) {
      await git(["update-index", "--skip-worktree", "--", ...tracked], worktreeDir);
    }
    return tracked;
  } catch {
    return [];
  }
}

/**
 * Reverses `hideTasksDirFromGit`: clears `--skip-worktree` on `trackedPaths` and restores their
 * real (pre-materialization) content via `git checkout HEAD --`, then removes any leftover
 * untracked scratch files under `tasks/` (new cards the planner created) with `git clean -fdx`
 * (the `-x` is required -- those files are gitignored, and plain `git clean -f` skips ignored
 * files by design). For a non-git worktreeDir (unit tests, `trackedPaths` always `[]` in that
 * case), falls back to a plain recursive delete. Best-effort throughout: a cleanup failure here
 * must never fail the run -- the worktree is discarded shortly after either way.
 */
async function unhideTasksDirFromGit(worktreeDir, trackedPaths) {
  if (!(await isGitRepo(worktreeDir))) {
    await fs.rm(path.join(worktreeDir, "tasks"), { recursive: true, force: true }).catch(() => {});
    return;
  }
  try {
    if (trackedPaths.length > 0) {
      await git(["update-index", "--no-skip-worktree", "--", ...trackedPaths], worktreeDir);
      await git(["checkout", "HEAD", "--", ...trackedPaths], worktreeDir);
    }
    await git(["clean", "-fdx", "--", "tasks"], worktreeDir);
  } catch {
    // best-effort -- see docstring
  }
}

/**
 * Phase 2's "ephemeral file view" (docs/design/cards-to-database.md, "The planner problem"):
 * exports every card from the DB to `<worktreeDir>/tasks/<id>.md` -- the exact serialized shape
 * `taskParser.serializeTask` produces -- so the planner agent's unmodified Read/Edit/Write/Bash
 * workflow (`promptBuilder.js`'s PLANNER_EXPANSION_WORKFLOW, `validateBacklog.js`) keeps working
 * against a real directory. The full backlog is exported, not just the target card, so
 * `depends_on` context and the validator's cycle/dangling-ref checks have the same data they'd
 * have against a real tasks/ tree. Returns `before` (a snapshot of every exported task keyed by
 * id, for `diffPlannerFileView` to compare the planner's edits against) and `hiddenPaths` (to
 * pass back to `cleanupPlannerFileView`).
 */
export async function materializePlannerFileView({ store, worktreeDir }) {
  const tasksDir = path.join(worktreeDir, "tasks");
  const hiddenPaths = await hideTasksDirFromGit(worktreeDir);
  await fs.rm(tasksDir, { recursive: true, force: true });
  await fs.mkdir(tasksDir, { recursive: true });

  const all = await store.list();
  const before = new Map();
  for (const task of all) {
    before.set(task.id, task);
    await fs.writeFile(path.join(tasksDir, `${task.id}.md`), serializeTask(task), "utf8");
  }
  return { tasksDir, before, hiddenPaths };
}

/** Removes the scratch tasks/ directory and restores git's view of it, after reconciliation. Safe to call even if materialization never happened. */
export async function cleanupPlannerFileView({ worktreeDir, hiddenPaths = [] }) {
  await unhideTasksDirFromGit(worktreeDir, hiddenPaths);
}

/**
 * Re-reads `<worktreeDir>/tasks/*.md` (whatever the planner left behind) and diffs it against
 * `before` (materializePlannerFileView's snapshot). Enforces the exact same guardrails
 * `plannerDiffGuard.js`'s git-diff-based `checkPlannerDiffGuard` does -- status never changes,
 * a card is never deleted -- by feeding it a `changes` array built from two in-memory maps
 * instead of two git refs (see docs/design/cards-to-database.md's recommended replacement).
 * A card file that fails to parse is itself a violation -- the planner's own
 * `validateBacklog.js` self-check should have caught this already, but this reconciliation step
 * is the actual enforcement point in db mode, so it does not trust that self-check ran.
 * Read-only: never writes to the store. Callers apply the returned plan via
 * `applyPlannerFileViewDiff`.
 */
export async function diffPlannerFileView({ tasksDir, before }) {
  let names = [];
  try {
    names = (await fs.readdir(tasksDir)).filter((n) => n.endsWith(".md"));
  } catch {
    names = [];
  }

  const after = new Map();
  const violations = [];
  for (const name of names) {
    const raw = await fs.readFile(path.join(tasksDir, name), "utf8");
    try {
      const task = parseTask(raw);
      after.set(task.id, task);
    } catch (err) {
      violations.push({ file: `tasks/${name}`, message: `failed to parse: ${err.message}` });
    }
  }
  if (violations.length > 0) {
    return { ok: false, violations };
  }

  const changes = [];
  for (const [id, task] of after) {
    const file = `tasks/${id}.md`;
    if (!before.has(id)) {
      changes.push({ file, status: "added" });
    } else {
      changes.push({
        file,
        status: "modified",
        oldRaw: serializeTask(before.get(id)),
        newRaw: serializeTask(task)
      });
    }
  }
  for (const [id, task] of before) {
    if (!after.has(id)) {
      changes.push({ file: `tasks/${id}.md`, status: "deleted", oldRaw: serializeTask(task) });
    }
  }

  const guard = checkPlannerDiffGuard(changes);
  if (!guard.ok) {
    return { ok: false, violations: guard.violations };
  }

  const creates = [];
  const updates = [];
  for (const [id, task] of after) {
    const prior = before.get(id);
    if (!prior) {
      creates.push(task);
      continue;
    }
    const patch = {};
    for (const field of MUTABLE_FIELDS) {
      if (JSON.stringify(prior[field]) !== JSON.stringify(task[field])) {
        patch[field] = task[field];
      }
    }
    if (Object.keys(patch).length > 0) {
      updates.push({ id, patch });
    }
  }

  return { ok: true, creates, updates };
}

/** Applies an `{ ok: true, creates, updates }` plan from diffPlannerFileView to `store`. Returns `{ createdIds, updatedIds }`. */
export async function applyPlannerFileViewDiff({ store, plan }) {
  const createdIds = [];
  const updatedIds = [];
  for (const task of plan.creates) {
    await store.create(task);
    createdIds.push(task.id);
  }
  for (const { id, patch } of plan.updates) {
    await store.update(id, patch);
    updatedIds.push(id);
  }
  return { createdIds, updatedIds };
}
