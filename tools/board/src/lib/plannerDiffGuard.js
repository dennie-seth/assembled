import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseTask } from "./taskParser.js";
import { APPROVAL_RECORD_FIELDS } from "./approvalGate.js";

const execFileAsync = promisify(execFile);

const CARD_FILE_RE = /^tasks\/[^/]+\.md$/;

/** Whether `filePath` (repo-relative, forward-slashed) is a top-level tasks/*.md card file. */
export function isCardFile(filePath) {
  return CARD_FILE_RE.test(filePath);
}

/**
 * Machine-checks the guardrails a planner run must never violate: an existing
 * card's `status` frontmatter changing, a card file being deleted, or an
 * approval record (`approved_by`/`approved_at`) being written or altered.
 *
 * The approval rule is the fs-mode counterpart of `plannerFileView`'s
 * `MUTABLE_FIELDS` allowlist, which drops those two fields in db mode: an
 * approval says a *human* looked at a card's deliverable and said yes (see
 * `approvalGate.js`), so it is only ever written by the server's own approval
 * paths. A planner that writes one into a card file would be forging exactly
 * the signal downstream cards unblock on. Setting `requires_approval` itself
 * is fine and deliberately not checked -- adding a gate is spec work.
 *
 * `changes` is the set of tasks/** diff entries between a planner
 * run's base and its HEAD -- see `collectTasksDiff` for how the script
 * entrypoint builds this from git. Reuses `taskParser` so "status" means
 * exactly what the schema says, not a raw string comparison; a card that
 * fails to parse on either side is left to the backlog validator, since
 * this guard's only job is the status/deletion invariant, not schema
 * validity. A legitimate split -- new cards created, the original retired
 * with an in-body note but its file and status left untouched -- passes,
 * because the original shows up as a `modified` entry with no status
 * change and the new cards show up as `added` entries with nothing to
 * compare against.
 */
export function checkPlannerDiffGuard(changes = []) {
  const violations = [];

  for (const change of changes) {
    const { file, status } = change;
    if (!isCardFile(file)) continue;

    if (status === "deleted") {
      violations.push({
        file,
        message:
          "Card file deleted -- planner runs must never delete a card (retire it in-body with an Obsolete/Superseded note instead)"
      });
      continue;
    }

    if (status === "added") continue;

    const { oldRaw, newRaw } = change;
    if (typeof oldRaw !== "string" || typeof newRaw !== "string") continue;

    let oldTask;
    let newTask;
    try {
      oldTask = parseTask(oldRaw);
    } catch {
      continue;
    }
    try {
      newTask = parseTask(newRaw);
    } catch {
      continue;
    }

    if (oldTask.status !== newTask.status) {
      violations.push({
        file,
        message: `status changed from "${oldTask.status}" to "${newTask.status}" on ${oldTask.id} -- planner runs must never touch status`
      });
    }

    for (const field of APPROVAL_RECORD_FIELDS) {
      if ((oldTask[field] ?? null) !== (newTask[field] ?? null)) {
        violations.push({
          file,
          message: `${field} changed on ${oldTask.id} -- the approval record is written only when a human approves the card, never by a planner run`
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

async function git(args, cwd) {
  try {
    return await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 * 16 });
  } catch (err) {
    throw new Error(`git ${args.join(" ")} failed: ${err.stderr || err.message}`);
  }
}

async function readAtRef({ cwd, ref, file }) {
  const { stdout } = await git(["show", `${ref}:${file}`], cwd);
  return stdout;
}

const STATUS_MAP = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "modified" };

/**
 * Builds the `changes` array `checkPlannerDiffGuard` expects, from the real
 * `tasks/**` diff between `baseRef` and `HEAD` in the git worktree at `cwd`
 * -- the glue the script entrypoint uses so the guard itself stays pure and
 * unit-testable without touching git.
 */
export async function collectTasksDiff({ cwd, baseRef = "develop" }) {
  const { stdout } = await git(["diff", "--name-status", `${baseRef}...HEAD`, "--", "tasks/"], cwd);
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const changes = [];
  for (const line of lines) {
    const parts = line.split("\t");
    const kind = parts[0][0];
    const status = STATUS_MAP[kind] ?? "modified";
    const isRename = kind === "R" || kind === "C";
    // Non-rename lines are "<status>\t<path>"; rename/copy lines are "<status>\t<oldPath>\t<newPath>".
    const oldPath = parts[1];
    const file = isRename ? parts[2] : parts[1];

    const change = { file, status };
    if (status !== "added") {
      change.oldRaw = await readAtRef({ cwd, ref: baseRef, file: oldPath }).catch(() => null);
    }
    if (status !== "deleted") {
      change.newRaw = await readAtRef({ cwd, ref: "HEAD", file }).catch(() => null);
    }
    changes.push(change);
  }
  return changes;
}
