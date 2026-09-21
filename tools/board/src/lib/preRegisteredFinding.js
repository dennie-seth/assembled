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

/** Every backtick-quoted citation in `text` that looks like a plausible repo path, with its match span. */
function iterateCitations(text) {
  const matches = [];
  for (const match of text.matchAll(CITATION_PATTERN)) {
    const cited = match[1];
    if (!looksLikeCitedPath(cited)) continue;
    matches.push({ cited, index: match.index, end: match.index + match[0].length });
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

/** The `{ start, end }` span of the sentence of `text` surrounding `index`. */
function sentenceRange(text, index) {
  let start = 0;
  for (const match of text.slice(0, index).matchAll(SENTENCE_END_PATTERN)) {
    start = match.index + 1;
  }
  const after = text.slice(index);
  const nextEnd = after.matchAll(SENTENCE_END_PATTERN).next().value;
  const end = nextEnd ? index + nextEnd.index + 1 : text.length;
  return { start, end };
}

// T-0395 FIX ROUND 2: FIX ROUND 1 bound an absence phrase to the citation's *clause*, splitting on a
// fixed list of separators (comma, "--", "while", etc). That still let one absence phrase claim every
// citation in the resulting segment when a Finding joined two independent claims with a conjunction
// the list didn't cover ("and") or a bare Markdown line break -- e.g. "`docs/missing.png` records the
// result and `assets/result.png` was not produced" classified BOTH paths absent, even though
// `docs/missing.png` is affirmatively cited. Widening the separator list only chases the next missed
// word; the fix instead binds an absence phrase to the *specific* citation it follows, by position,
// not by vocabulary.
//
// A citation's "claim window" is the text strictly between it and whichever comes first: the next
// citation (so a later citation's own absence phrase can never reach backward across it) or the end
// of its own sentence (so an absence phrase in a later, unrelated sentence can never reach back
// either).
function citationClaimWindow(text, citation, nextCitation) {
  const sentenceEnd = sentenceRange(text, citation.index).end;
  const windowEnd = nextCitation ? Math.min(nextCitation.index, sentenceEnd) : sentenceEnd;
  return text.slice(citation.end, windowEnd);
}

// T-0395 FIX ROUND 3: FIX ROUND 2's claim window fixed leakage BETWEEN two cited paths, but it still
// let an absence phrase with NO citation of its own reach back to whichever citation happened to
// precede it in the window -- e.g. "`docs/missing.png` records the result, but the final artifact was
// not produced" classified `docs/missing.png` absent even though the sentence names it as the thing
// that *records the result*; the absence is about "the final artifact", an uncited noun phrase.
// Positional proximity inside the window is not a binding rule.
//
// The binding rule this round adopts: a citation is absent ONLY when an `ABSENCE_PHRASE_PATTERN`
// predicate is DIRECTLY ATTACHED to it -- the predicate is the very next thing in the text after the
// citation (module leading whitespace), i.e. the citation reads as the predicate's own grammatical
// subject ("`path` does not exist", "`path` was not produced"). Any other wording -- the predicate
// appearing later in the window, attached to some other noun phrase -- defaults to present/
// claimed-and-required. This is deliberately conservative: an unresolvable binding must never waive a
// citation's existence check (per this card's own round-2 "ambiguous positive evidence is treated
// conservatively" requirement), and a later negative phrase must never be inferred to refer to the
// closest preceding path just because nothing else is nearby.
//
// A Finding that wants to mark a citation absent should therefore always phrase it as directly
// attached: `path/to/thing.png` does not exist / was not produced / is not promoted -- with the
// citation immediately followed by the predicate, not separated from it by an intervening clause.
function citationHasDirectAbsencePredicate(window) {
  const trimmed = window.replace(/^\s+/, "");
  const match = ABSENCE_PHRASE_PATTERN.exec(trimmed);
  return match !== null && match.index === 0;
}

/**
 * Splits a Finding section's citations into `present` (required evidence -- must exist) and
 * `absent` (the Finding itself claims this path does not exist, e.g. "No reference is promoted --
 * `path/to/thing.png` does not exist on this branch") based on whether an `ABSENCE_PHRASE_PATTERN`
 * predicate is DIRECTLY ATTACHED to that specific citation -- the citation is the predicate's own
 * subject, i.e. the predicate is the next thing in the text after the citation (see
 * `citationHasDirectAbsencePredicate`). Every other wording defaults to present/required: a
 * stop-and-report Finding naturally names the artifact it did NOT produce, but only a citation
 * phrased as directly attached to its own absence predicate ("`path` does not exist / was not
 * produced / is not promoted") is exempted from the existence check -- proximity to some other
 * negative phrase elsewhere in the sentence never is.
 */
export function classifyFindingEvidenceCitations(findingText) {
  const citations = iterateCitations(findingText);
  const seen = new Set();
  const present = [];
  const absent = [];
  citations.forEach((citation, i) => {
    if (seen.has(citation.cited)) return;
    seen.add(citation.cited);
    const window = citationClaimWindow(findingText, citation, citations[i + 1]);
    if (citationHasDirectAbsencePredicate(window)) {
      absent.push(citation.cited);
    } else {
      present.push(citation.cited);
    }
  });
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
          `Card ${task.id}'s "${FINDING_HEADING}" section cites "${citedPath}" as evidence, but no file exists at that path -- cited evidence must actually be committed, not just named. If this path is meant to be recorded as absent, the absence predicate must attach directly to it (e.g. \`${citedPath}\` does not exist / was not produced / is not promoted) -- a negative phrase elsewhere in the sentence about something else does not exempt it.`
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
