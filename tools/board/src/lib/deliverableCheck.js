import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkFindingWithEvidence, readSection, parseFindingEvidencePaths } from "./preRegisteredFinding.js";

const execFileAsync = promisify(execFile);

async function defaultFileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * T-0352 fix (a): every file `git` has actually committed under `repoRoot`, on the current
 * branch. Failing/erroring (not a git repo, `git` unavailable) returns `[]` rather than
 * throwing -- fail closed, since an empty committed-files list makes the non-opt-in fallback
 * check below FAIL rather than silently skip, which is the safer default for a gate whose whole
 * point is refusing to take "some attachment exists somewhere" as proof of a deliverable.
 */
async function defaultListCommittedFiles(repoRoot) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "ls-files"]);
    return stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * T-0352: `checkDeliverable` used to treat "some attachments recorded and present on disk" as
 * proof a card's deliverable existed -- but an attachment is board-side evidence storage, not a
 * claim about what's actually committed. A run that attaches its failed-attempt/evidence PNGs
 * (exactly what the board attachments API is *for* -- see .claude/rules/assets.md and T-0314's
 * evidence-promotion mechanism) satisfies that check with no deliverable ever produced; this is
 * the T-0351 regression -- the gate exited 0 on six evidence PNGs with no master sheet ever
 * committed, and it took a human reading the filesystem by hand to catch it twice in one day.
 *
 * Two routes now distinguish the deliverable from evidence, in order of precision:
 *
 * 1. `"## Deliverable"` (opt-in, precise): reuses the exact citation convention T-0342's
 *    `"## Finding"` section already established (`parseFindingEvidencePaths`: a backtick-quoted,
 *    extensioned path) -- a card names the committed path(s) its deliverable is expected to land
 *    at, and this check verifies each one is a real file under `repoRoot`, independent of how
 *    many attachments are recorded.
 * 2. The non-opt-in fallback below (`hasCommittedAttachment`), used whenever a card has no
 *    parseable `"## Deliverable"` section: at least one recorded attachment's filename must also
 *    correspond to a file `git` actually has committed somewhere under `repoRoot`. This is what
 *    closes the hole for every card that never adopts the `"## Deliverable"` convention -- a
 *    first attempt at this fix made the whole check opt-in, so the exact T-0351 card (which has
 *    no `"## Deliverable"` section) still passed on attachment-count alone; see the T-0352
 *    reviewer's FAIL for the empirical repro (`checkDeliverable.js T-0351 --require-artifact`
 *    still exiting 0). Matching by filename rather than requiring a declared path is deliberately
 *    coarser than route 1 -- it only proves *something* attached was actually committed, not
 *    that a specific claimed path exists -- but that coarseness is exactly what makes it apply
 *    with no card-side action required, which a "necessary but not sufficient" mechanical
 *    backstop needs in order to actually backstop anything.
 */
export const DELIVERABLE_HEADING = "## Deliverable";

function parseDeclaredDeliverablePaths(body) {
  return parseFindingEvidencePaths(readSection(body, DELIVERABLE_HEADING));
}

/** Whether any recorded attachment's filename matches a file `git` has actually committed under `repoRoot`. */
async function hasCommittedAttachment(attachments, repoRoot, listCommittedFiles) {
  const committedBasenames = new Set((await listCommittedFiles(repoRoot)).map((f) => path.basename(f)));
  return attachments.some((attachment) => committedBasenames.has(attachment.filename));
}

/**
 * Verifies a card whose `deliverable_type` is "artifact" actually produced
 * the artifact it claims -- not just code that could produce one. A card's
 * `attachments[]` frontmatter (populated only by a real
 * `POST /api/tasks/:id/attachments` call, never by an implementer editing
 * `tasks/**` directly -- implementers have no Write/Edit access there) is
 * the one place a real, board-recorded deliverable shows up; an "artifact"
 * card with an empty attachments list is exactly the T-0136 failure mode:
 * an uploader CLI with fully mocked, green tests that never actually
 * uploaded anything. When `attachmentsDir` is supplied, each recorded
 * attachment is additionally cross-checked against the file it claims
 * exists on disk (`tasks/attachments/<id>/<filename>`, per the attachments
 * feature) -- a frontmatter entry with no backing file is the same failure
 * mode by a different route. A `deliverable_type` other than "artifact"
 * (the default, "code") is not applicable -- this check has nothing to say
 * about code-deliverable cards -- unless `requireArtifact` is passed.
 *
 * `requireArtifact` overrides that default-"code" exemption: pass `true`
 * when the caller has independent evidence (not the card's own
 * self-reported `deliverable_type`) that this card must have a produced
 * deliverable attached. `verifyRouter.js`'s `resolveDeliverableRoute` sets
 * this when the diff itself adds/updates a file under a known
 * artifact-producing path (`assets/final/**`, `assets/src/concept/**`,
 * `assets/src/keyart/**`) -- the mechanical backstop for the pattern where
 * several art/audio cards (character sheets, concept art, an ambience bed)
 * were committed straight to the repo tagged `deliverable_type: "code"`
 * and never attached, so the plain `deliverable_type`-gated check above
 * never even ran for them.
 *
 * T-0342: when a genuine `deliverable_type: "artifact"` card (never a
 * `requireArtifact`-only diff-triggered one) has no valid attachment, it gets one more
 * chance before failing -- `checkFindingWithEvidence` (preRegisteredFinding.js), which PASSes
 * a card that pre-registered an experiment (checked against `beforeBody`, the task's body
 * *before* this run -- never the current body, so pre-registration can't be added retroactively
 * to rescue an empty run) and whose current body records a decisive, evidenced finding instead of
 * a promoted artifact. `beforeBody`/`repoRoot` are optional: omitting either simply skips this
 * route and preserves the exact pre-T-0342 failure behaviour.
 */
export async function checkDeliverable(
  task,
  {
    attachmentsDir,
    requireArtifact = false,
    beforeBody,
    repoRoot,
    fileExists = defaultFileExists,
    listCommittedFiles = defaultListCommittedFiles
  } = {}
) {
  if (!task || (task.deliverable_type !== "artifact" && !requireArtifact)) {
    return { ok: true, applicable: false, errors: [] };
  }

  const errors = [];
  const attachments = Array.isArray(task.attachments) ? task.attachments : [];
  let attachmentsOk = attachments.length > 0;

  if (attachments.length === 0) {
    errors.push(
      `Card ${task.id} is deliverable_type: "artifact" but has no attachments recorded -- code that could produce the deliverable is not the deliverable itself.`
    );
  } else if (attachmentsDir) {
    for (const attachment of attachments) {
      const filePath = path.join(attachmentsDir, task.id, attachment.filename);
      if (!(await fileExists(filePath))) {
        errors.push(
          `Attachment "${attachment.filename}" is recorded in ${task.id}'s frontmatter but the file does not exist at ${filePath}.`
        );
        attachmentsOk = false;
      }
    }
  }

  if (repoRoot) {
    const declaredPaths = parseDeclaredDeliverablePaths(task.body ?? "");
    if (declaredPaths.length > 0) {
      for (const declaredPath of declaredPaths) {
        if (!(await fileExists(path.join(repoRoot, declaredPath)))) {
          errors.push(
            `Card ${task.id} declares "${declaredPath}" under "${DELIVERABLE_HEADING}" but no committed file exists at that path -- attachments (including evidence/attempt uploads) are not a substitute for the deliverable actually existing at its stated, committed location.`
          );
          attachmentsOk = false;
        }
      }
    } else if (attachments.length > 0 && !(await hasCommittedAttachment(attachments, repoRoot, listCommittedFiles))) {
      errors.push(
        `Card ${task.id} has ${attachments.length} attachment(s) recorded, but none of their filenames correspond to a file ` +
          `actually committed on the branch -- an attachment alone (including an evidence/failed-attempt upload, which the ` +
          `board attachments API is also used for -- see T-0314's evidence-promotion mechanism) is not proof a deliverable ` +
          `was produced. Either declare the deliverable's expected path under a "${DELIVERABLE_HEADING}" section, or commit ` +
          `the actual deliverable file and record it as an attachment.`
      );
      attachmentsOk = false;
    }
  }

  if (attachmentsOk) {
    return { ok: true, applicable: true, errors: [] };
  }

  if (task.deliverable_type === "artifact" && typeof beforeBody === "string") {
    const finding = await checkFindingWithEvidence({ task, beforeBody, repoRoot, fileExists });
    if (finding.applicable) {
      return { ok: finding.ok, applicable: true, errors: finding.ok ? [] : [...errors, ...finding.errors] };
    }
  }

  return { ok: false, applicable: true, errors };
}
