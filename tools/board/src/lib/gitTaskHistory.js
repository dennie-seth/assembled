import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseTask } from "./taskParser.js";

const execFileAsync = promisify(execFile);

/**
 * The task's own body as it stood at the merge-base between `baseRef` and `HEAD` -- i.e. before
 * the branch being reviewed diverged from base, matching the same `${baseRef}...HEAD` semantics
 * `gitOps.js`'s `diffNames` and `plannerDiffGuard.js`'s `collectTasksDiff` already use elsewhere
 * in this codebase. This is the "before the run" snapshot T-0342's pre-registration check is
 * pinned to: reading at `baseRef`'s own current tip instead would be wrong if base moved forward
 * *after* this branch was cut -- a later, unrelated merge into base must never count as "before
 * this run".
 *
 * Never throws: a task file that doesn't exist yet at the merge-base (a brand-new card), an
 * unresolvable `baseRef`, or a `cwd` that isn't a git checkout at all all resolve to `""` -- no
 * pre-registration existed before the run, which is the correct, safe default (the caller falls
 * through to the plain artifact-required check).
 */
export async function readTaskBodyAtMergeBase({ cwd, id, baseRef = "develop" }) {
  try {
    const { stdout: mergeBaseOut } = await execFileAsync("git", ["merge-base", baseRef, "HEAD"], { cwd });
    const mergeBase = mergeBaseOut.trim();
    const { stdout: raw } = await execFileAsync("git", ["show", `${mergeBase}:tasks/${id}.md`], {
      cwd,
      maxBuffer: 1024 * 1024 * 16
    });
    return parseTask(raw).body;
  } catch {
    return "";
  }
}

/**
 * T-0354: the freshness gate's fs-mode "run start" boundary -- the earliest commit made on this
 * branch beyond `baseRef`, i.e. the implementer's first commit of this run (`git log
 * ${baseRef}..HEAD --reverse` walks oldest-first). Deliberately the same coarseness
 * `readTaskBodyAtMergeBase` already accepts for fs-mode -- a per-branch boundary, not a
 * per-attempt one, since fs-mode task files carry no card_events-style audit trail to pin a
 * specific retry's own start. fs-mode is the legacy path (most live cards are db-mode, see
 * `dbTaskHistory.js`'s `readRunStartTimestamp` for the precise per-attempt equivalent); this
 * coarseness is an accepted tradeoff, not an oversight.
 *
 * Falls back to the merge-base commit's own date when the branch has no commits beyond `baseRef`
 * yet (a run whose entire diff is still uncommitted) -- some boundary is better than none. Never
 * throws: an unresolvable `baseRef` or a `cwd` that isn't a git checkout resolves to `""`, mirroring
 * `readTaskBodyAtMergeBase`'s own safe default.
 */
export async function readRunStartTimestamp({ cwd, baseRef = "develop" }) {
  try {
    const { stdout } = await execFileAsync("git", ["log", `${baseRef}..HEAD`, "--format=%aI", "--reverse"], { cwd });
    const dates = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (dates.length > 0) {
      return dates[0];
    }

    const { stdout: mergeBaseOut } = await execFileAsync("git", ["merge-base", baseRef, "HEAD"], { cwd });
    const { stdout: mergeBaseDate } = await execFileAsync("git", ["show", "-s", "--format=%aI", mergeBaseOut.trim()], {
      cwd
    });
    return mergeBaseDate.trim();
  } catch {
    return "";
  }
}
