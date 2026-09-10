import { promises as fs } from "node:fs";
import path from "node:path";
import { checkFindingWithEvidence } from "./preRegisteredFinding.js";

async function defaultFileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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
