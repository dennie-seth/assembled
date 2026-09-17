import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * T-0342: "finding with evidence" as a first-class PASS for `deliverable_type: "artifact"` cards,
 * but only when pre-registered. T-0259 ran 13 sessions producing genuine, reproducible findings
 * and was recorded as 13 failures because the deliverable never appeared -- session 13 is the
 * clean case: it ran the pre-registered experiment, got a decisive falsifying result, stopped as
 * instructed, and was FAILed anyway for having no artifact. That is the loop punishing exactly the
 * behaviour it should reward.
 *
 * `checkFindingWithEvidence` is the mechanical gate for the alternative PASS route.
 * `deliverableCheck.js` calls it only after the plain artifact/attachment check has already
 * failed, and only ever checks `PRE_REGISTRATION_HEADING` against `beforeBody` -- the task's own
 * body as it stood before the implementer's branch diverged from base (see
 * `gitTaskHistory.js`'s `readTaskBodyAtMergeBase`). The card's *current* body is never consulted
 * for pre-registration, so a "## Pre-registered experiment" section added during the run itself
 * can never satisfy this -- pre-registration must predate the run it's supposedly gating, or it's
 * just a retroactive excuse for an empty one.
 */
export const PRE_REGISTRATION_HEADING = "## Pre-registered experiment";
export const FINDING_HEADING = "## Finding";

/** Text between `heading` and the next top-level `## ` heading (or end of body), trimmed. */
export function readSection(body, heading) {
  if (typeof body !== "string") return "";
  const start = body.indexOf(heading);
  if (start === -1) return "";
  const afterHeading = start + heading.length;
  const nextHeading = body.indexOf("\n## ", afterHeading);
  const raw = nextHeading === -1 ? body.slice(afterHeading) : body.slice(afterHeading, nextHeading);
  return raw.trim();
}

/** Whether `body` (a snapshot of a task's body at some point in time) carries a non-empty pre-registration section. */
export function hasPreRegisteredExperiment(body) {
  return readSection(body, PRE_REGISTRATION_HEADING).length > 0;
}

export function readFindingSection(body) {
  return readSection(body, FINDING_HEADING);
}

// A backtick span whose content is a bare path ending in a file extension -- deliberately
// excludes bare words/inline commands (`npm test`, `main`) the same way evidencePromotion.js's
// own CITATION_PATTERN does, so an inline-code mention that isn't a file path is never mistaken
// for cited evidence.
const CITATION_PATTERN = /`([^`\s]+\.[A-Za-z0-9]+)`/g;

/** Every backtick-quoted, extensioned file path a Finding section cites, in first-seen order, deduped. */
export function parseFindingEvidencePaths(findingText) {
  const seen = new Set();
  const ordered = [];
  for (const match of findingText.matchAll(CITATION_PATTERN)) {
    const cited = match[1];
    if (seen.has(cited)) continue;
    seen.add(cited);
    ordered.push(cited);
  }
  return ordered;
}

/** Requires the literal word "decisive" -- mechanical, not a judgment call the reviewer has to make. */
export function isDecisiveFinding(findingText) {
  return /\bdecisive\b/i.test(findingText ?? "");
}

async function defaultFileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The finding-with-evidence route. Applicable only when `beforeBody` already carried a
 * pre-registered experiment -- never consults `task.body` (the current, post-run body) for
 * pre-registration. When applicable, the current body's Finding section must exist, state the
 * result is decisive, and cite at least one evidence file that actually exists on disk under
 * `repoRoot` -- committed frames/measurements, not a narrative.
 */
export async function checkFindingWithEvidence({
  task,
  beforeBody,
  repoRoot,
  fileExists = defaultFileExists
}) {
  if (!hasPreRegisteredExperiment(beforeBody)) {
    return { ok: false, applicable: false, errors: [] };
  }

  const errors = [];
  const findingText = readFindingSection(task?.body ?? "");

  if (!findingText) {
    errors.push(
      `Card ${task.id} pre-registered an experiment (before this run) but its current body has no "${FINDING_HEADING}" section recording the run's result -- a pre-registered experiment with no recorded finding is still a FAIL.`
    );
    return { ok: false, applicable: true, errors };
  }

  if (!isDecisiveFinding(findingText)) {
    errors.push(
      `Card ${task.id}'s "${FINDING_HEADING}" section does not state a decisive result -- write "decisive" explicitly once the run's outcome is unambiguous (confirms or falsifies the pre-registered prediction); an inconclusive or narrative-only finding is still a FAIL.`
    );
  }

  const cited = parseFindingEvidencePaths(findingText);
  if (cited.length === 0) {
    errors.push(
      `Card ${task.id}'s "${FINDING_HEADING}" section cites no evidence file -- back the decisive result with at least one committed frame/measurement, referenced with a backtick-quoted path (e.g. \`docs/assets/evidence/${task.id}/attempt_8_main.png\`); a narrative claim alone is still a FAIL.`
    );
  } else {
    for (const citedPath of cited) {
      const exists = repoRoot ? await fileExists(path.join(repoRoot, citedPath)) : false;
      if (!exists) {
        errors.push(
          `Card ${task.id}'s "${FINDING_HEADING}" section cites "${citedPath}" as evidence, but no file exists at that path -- cited evidence must actually be committed, not just named.`
        );
      }
    }
  }

  return { ok: errors.length === 0, applicable: true, errors };
}
