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

// A backtick span with no internal whitespace -- the raw candidate set before filtering by
// `looksLikeCitedPath`. Deliberately excludes multi-word spans (`` `npm test` ``) the same way
// evidencePromotion.js's own CITATION_PATTERN does.
const CITATION_PATTERN = /`([^`\s]+)`/g;

// A citation counts as a plausible repo path only if it has a path separator (`assets/final/...`)
// or ends in a known evidence/code extension (a bare `main_384.png` cited with no directory, the
// shape T-0272's own attempt logs actually use). Neither test alone is enough on its own: a bare
// extensionless word like `main` has no separator and no extension; a prompt weight like `:1.4` or
// `(lens:1.4)`, a version number like `v1.2.3`, or any other dotted identifier has a dot but no
// path separator and no extension this list recognizes -- T-0395: the prior rule (any dot plus an
// alnum tail) accepted all of those as "cited evidence" and then failed them for not existing.
const KNOWN_EVIDENCE_EXTENSIONS = /\.(png|jpe?g|webp|gif|md|json|txt|log|csv|py|js|mjs|cjs|ts|tsx|cpp|cc|h|hpp|sql|yml|yaml)$/i;
const PATH_SEPARATOR_PATTERN = /\//;

function looksLikeCitedPath(candidate) {
  return PATH_SEPARATOR_PATTERN.test(candidate) || KNOWN_EVIDENCE_EXTENSIONS.test(candidate);
}

/** Every backtick-quoted citation in `text` that looks like a plausible repo path, with its match index. */
function iterateCitations(text) {
  const matches = [];
  for (const match of text.matchAll(CITATION_PATTERN)) {
    const cited = match[1];
    if (!looksLikeCitedPath(cited)) continue;
    matches.push({ cited, index: match.index });
  }
  return matches;
}

/** Every backtick-quoted, plausible-path citation a Finding section cites, in first-seen order, deduped. */
export function parseFindingEvidencePaths(findingText) {
  const seen = new Set();
  const ordered = [];
  for (const { cited } of iterateCitations(findingText)) {
    if (seen.has(cited)) continue;
    seen.add(cited);
    ordered.push(cited);
  }
  return ordered;
}

// A clause saying the cited path does NOT exist -- the three phrasings T-0395's acceptance
// criteria names verbatim ("does not exist" / "was not produced" / "is not promoted"), plus the
// tense/number variants a Finding's prose naturally uses. Deliberately literal rather than a
// broader NLP heuristic: this is a mechanical gate, and a false negative here (an absence framed
// in words this pattern doesn't recognize) degrades to the pre-T-0395 behaviour -- the path is
// still checked, just as required evidence -- rather than silently waving a real gap through.
const ABSENCE_PHRASE_PATTERN =
  /\b(?:does|did)\s+not\s+exist\b|\b(?:was|were)\s+not\s+(?:produced|created|written|committed|generated)\b|\b(?:is|are)\s+not\s+(?:promoted|produced|present|committed)\b/i;

// A true sentence-end period: one followed by whitespace, a closing `**` bold marker, or end of
// string -- same rule evidencePromotion.js's own SENTENCE_END_PATTERN uses, and for the same
// reason here: a decimal inside a cited filename (`attempt_1_main_1024.png`) or a measurement
// (`denoise 0.87`) is always followed directly by another character, never whitespace, so it's
// never mistaken for a sentence boundary the way a naive "nearest dot" scan would.
const SENTENCE_END_PATTERN = /\.(?=\s|\*\*|$)/g;

/** The sentence of `text` surrounding `index` -- the scope an absence phrase must appear in to count. */
function sentenceAround(text, index) {
  let start = 0;
  for (const match of text.slice(0, index).matchAll(SENTENCE_END_PATTERN)) {
    start = match.index + 1;
  }
  const after = text.slice(index);
  const nextEnd = after.matchAll(SENTENCE_END_PATTERN).next().value;
  const end = nextEnd ? index + nextEnd.index + 1 : text.length;
  return text.slice(start, end);
}

/**
 * Splits a Finding section's citations into `present` (required evidence -- must exist) and
 * `absent` (the Finding itself claims this path does not exist, e.g. "No reference is promoted --
 * `path/to/thing.png` does not exist on this branch") based on whether an `ABSENCE_PHRASE_PATTERN`
 * clause shares the same sentence as the citation. T-0395: a stop-and-report Finding naturally
 * names the artifact it did NOT produce, and that citation was previously indistinguishable from a
 * citation of real, present evidence -- this is what makes the distinction.
 */
export function classifyFindingEvidenceCitations(findingText) {
  const seen = new Set();
  const present = [];
  const absent = [];
  for (const { cited, index } of iterateCitations(findingText)) {
    if (seen.has(cited)) continue;
    seen.add(cited);
    const clause = sentenceAround(findingText, index);
    if (ABSENCE_PHRASE_PATTERN.test(clause)) {
      absent.push(cited);
    } else {
      present.push(cited);
    }
  }
  return { present, absent };
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
    return { ok: false, applicable: false, errors: [], absentEvidence: [] };
  }

  const errors = [];
  const findingText = readFindingSection(task?.body ?? "");

  if (!findingText) {
    errors.push(
      `Card ${task.id} pre-registered an experiment (before this run) but its current body has no "${FINDING_HEADING}" section recording the run's result -- a pre-registered experiment with no recorded finding is still a FAIL.`
    );
    return { ok: false, applicable: true, errors, absentEvidence: [] };
  }

  if (!isDecisiveFinding(findingText)) {
    errors.push(
      `Card ${task.id}'s "${FINDING_HEADING}" section does not state a decisive result -- write "decisive" explicitly once the run's outcome is unambiguous (confirms or falsifies the pre-registered prediction); an inconclusive or narrative-only finding is still a FAIL.`
    );
  }

  const { present, absent } = classifyFindingEvidenceCitations(findingText);

  if (present.length === 0) {
    errors.push(
      `Card ${task.id}'s "${FINDING_HEADING}" section cites no evidence file -- back the decisive result with at least one committed frame/measurement, referenced with a backtick-quoted path (e.g. \`docs/assets/evidence/${task.id}/attempt_8_main.png\`); a narrative claim alone is still a FAIL.`
    );
  } else {
    for (const citedPath of present) {
      const exists = repoRoot ? await fileExists(path.join(repoRoot, citedPath)) : false;
      if (!exists) {
        errors.push(
          `Card ${task.id}'s "${FINDING_HEADING}" section cites "${citedPath}" as evidence, but no file exists at that path -- cited evidence must actually be committed, not just named.`
        );
      }
    }
  }

  for (const citedPath of absent) {
    const exists = repoRoot ? await fileExists(path.join(repoRoot, citedPath)) : false;
    if (exists) {
      errors.push(
        `Card ${task.id}'s "${FINDING_HEADING}" section claims "${citedPath}" does not exist, but a file exists at that path -- an absence claim must be true.`
      );
    }
  }

  return { ok: errors.length === 0, applicable: true, errors, absentEvidence: absent };
}
