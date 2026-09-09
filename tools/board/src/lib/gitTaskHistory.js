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
