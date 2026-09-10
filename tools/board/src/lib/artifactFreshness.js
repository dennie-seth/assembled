import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseHostActionRequest } from "./hostActionRequest.js";

const execFileAsync = promisify(execFile);

/**
 * Every commit made on `repoRoot`'s current branch since `sinceIso`, as `{ sha, message,
 * changedPaths }` -- `message` is the FULL commit message (`%B`, not just the subject), since a
 * host-action-request block (see `hostActionRequest.js`) is written as a multi-line fenced block
 * that would never survive a subject-only read. Two `git` calls per commit (message, then changed
 * paths) rather than one combined `--format`/`--name-only` invocation: `%B` can itself contain
 * blank lines, which makes it impossible to reliably tell "end of message" from "start of the
 * name-only file list" in a single stream -- this run's commit count is always small (a handful),
 * so the extra calls cost nothing that matters.
 *
 * Fails closed to `[]` on any error (not a git repo, `git` unavailable, bad `sinceIso`) -- same
 * convention `deliverableCheck.js`'s own `defaultListCommittedBlobs` already uses: an empty result
 * makes the freshness check FAIL rather than silently skip, which is the safer default for a gate
 * whose entire point is refusing to take "some artifact exists" as proof this run produced it.
 */
export async function defaultListCommitsSince(repoRoot, sinceIso) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "log", `--since=${sinceIso}`, "--format=%H"]);
    const shas = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    return await Promise.all(
      shas.map(async (sha) => {
        const [{ stdout: message }, { stdout: changed }] = await Promise.all([
          execFileAsync("git", ["-C", repoRoot, "log", "-1", "--format=%B", sha]),
          execFileAsync("git", ["-C", repoRoot, "diff-tree", "--no-commit-id", "--name-only", "-r", sha])
        ]);
        return {
          sha,
          message,
          changedPaths: changed
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        };
      })
    );
  } catch {
    return [];
  }
}

/**
 * T-0354: the freshness half of the deliverable gate. `deliverableCheck.js`'s existing checks
 * (T-0352) prove a card's claimed deliverable path is a real, committed file -- they say nothing
 * about *when* it was committed, which is exactly the gap the third consecutive T-0351 run
 * exposed: a previously-promoted master sheet satisfied "does it exist" while the run itself only
 * ever touched generator/test `.py` files, tests green, two commits, zero new images, and the
 * model was never invoked.
 *
 * `verifiedPaths` is deliberately supplied by the caller rather than re-derived here --
 * `checkDeliverable()` already knows exactly which path(s) its own existence check just verified
 * (the declared `"## Deliverable"` path(s), or the fallback's matched committed-attachment
 * path(s)); re-deriving that here would duplicate T-0352's matching logic instead of composing
 * with it, which the card's own "Do not" section rules out.
 *
 * Not applicable (skipped entirely, `ok: true`) when `runStartTime`, `repoRoot`, or a non-empty
 * `verifiedPaths` isn't supplied -- callers that don't yet have a run-start boundary (every
 * existing `checkDeliverable()` call site before this card) keep their exact prior behaviour.
 *
 * PASSes when at least one `verifiedPath` was touched (added or modified) by a commit made since
 * `runStartTime` -- proof this run's own commits, not an earlier run's, produced or updated it.
 *
 * Also PASSes -- distinct from "never tried" -- when one of this run's commit messages carries a
 * complete, well-formed `` ```host-action-request ``` `` block (see `hostActionRequest.js` /
 * `.claude/rules/conduct.md`): a genuine host-only outage that blocked invoking the model before
 * this run could produce anything is not the failure mode this gate exists to catch, and must
 * stay distinguishable from it.
 */
export async function checkArtifactFreshness({
  task,
  verifiedPaths,
  runStartTime,
  repoRoot,
  listCommitsSince = defaultListCommitsSince
} = {}) {
  if (!runStartTime || !repoRoot || !Array.isArray(verifiedPaths) || verifiedPaths.length === 0) {
    return { ok: true, applicable: false, errors: [] };
  }

  const commits = await listCommitsSince(repoRoot, runStartTime);

  if (commits.some((commit) => parseHostActionRequest(commit.message))) {
    return { ok: true, applicable: true, errors: [] };
  }

  const touchedPaths = new Set(commits.flatMap((commit) => commit.changedPaths));
  if (verifiedPaths.some((verifiedPath) => touchedPaths.has(verifiedPath))) {
    return { ok: true, applicable: true, errors: [] };
  }

  return {
    ok: false,
    applicable: true,
    errors: [
      `Card ${task?.id ?? "?"}'s verified deliverable path(s) (${verifiedPaths.join(", ")}) exist, but none were ` +
        `touched by a commit made since this run started (${runStartTime}) -- an artifact that predates this run ` +
        `is not evidence this run ever invoked the model (T-0354). Either commit a freshly generated deliverable, ` +
        "record a genuine host outage with a ```host-action-request``` block (.claude/rules/conduct.md) in a " +
        'commit message, or, for a pre-registered experiment, record a decisive "## Finding" instead.'
    ]
  };
}
