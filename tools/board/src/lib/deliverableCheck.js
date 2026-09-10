import { promises as fs } from "node:fs";
import path from "node:path";
import { checkFindingWithEvidence, readSection, parseFindingEvidencePaths } from "./preRegisteredFinding.js";

async function defaultFileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
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
 * `"## Deliverable"` reuses the exact citation convention T-0342's `"## Finding"` section
 * already established (`parseFindingEvidencePaths`: a backtick-quoted, extensioned path) -- a
 * card names the committed path(s) its deliverable is expected to land at, and this check
 * verifies each one is a real file under `repoRoot`, independent of how many attachments are
 * recorded. Deliberately opt-in: a card with no `"## Deliverable"` section is unaffected (see
 * `checkDeliverable`'s call site below) -- this is a necessary-but-not-sufficient mechanical
 * backstop, not a claim that every artifact card has adopted the convention yet.
 */
export const DELIVERABLE_HEADING = "## Deliverable";

function parseDeclaredDeliverablePaths(body) {
  return parseFindingEvidencePaths(readSection(body, DELIVERABLE_HEADING));
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
  { attachmentsDir, requireArtifact = false, beforeBody, repoRoot, fileExists = defaultFileExists } = {}
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
    for (const declaredPath of declaredPaths) {
      if (!(await fileExists(path.join(repoRoot, declaredPath)))) {
        errors.push(
          `Card ${task.id} declares "${declaredPath}" under "${DELIVERABLE_HEADING}" but no committed file exists at that path -- attachments (including evidence/attempt uploads) are not a substitute for the deliverable actually existing at its stated, committed location.`
        );
        attachmentsOk = false;
      }
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
