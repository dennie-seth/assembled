// T-0405: the heading text must BEGIN with the word "Acceptance" (case-insensitive) right after
// the leading #s and required whitespace -- any suffix after that word is tolerated ("## Acceptance
// (story-level -- planner expands)", "## Acceptance criteria", "## Acceptance:", ...), because
// that's the exact shape that hard-blocked T-0403 twice despite a well-formed checklist. The
// boundary right after "Acceptance" must NOT itself be a letter, digit, or hyphen, so a heading
// that only glues onto the word ("## Acceptance-adjacent notes") or merely mentions it elsewhere
// ("## Notes on Acceptance", "## How acceptance is judged") is never mistaken for the section.
// Heading level is 1-6, matching vetAndReady.js's own tolerant parse of the same section --
// ACCEPTANCE_HEADING_TEXT_SRC is the single fragment both files build their regex from, so they
// can no longer diverge on what counts as "the" Acceptance heading (see vetAndReady.js).
export const ACCEPTANCE_HEADING_TEXT_SRC = "Acceptance(?![A-Za-z0-9-])";
export const ACCEPTANCE_HEADING_RE = new RegExp(`^#{1,6}\\s+${ACCEPTANCE_HEADING_TEXT_SRC}`, "i");
export const HEADING_RE = /^#{1,6}\s+/;
export const CHECKBOX_RE = /^-\s*\[([ xX])\]\s*(.+)$/;

/**
 * Extracts the checkbox items under a card body's `## Acceptance` section --
 * the body-level convention every card already follows (docs/PLAN.md's Task
 * file schema) -- rather than a duplicate frontmatter list that could drift
 * out of sync with it. Stops at the next heading of any level. Returns []
 * when there is no Acceptance section at all, which the reviewer prompt
 * treats as a hard FAIL rather than "nothing to check" (see reviewerPrompt.js).
 */
export function parseAcceptanceCriteria(body) {
  if (typeof body !== "string") {
    return [];
  }
  const lines = body.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => ACCEPTANCE_HEADING_RE.test(line.trim()));
  if (startIdx === -1) {
    return [];
  }
  const items = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (HEADING_RE.test(line)) {
      break;
    }
    const match = CHECKBOX_RE.exec(line);
    if (match) {
      items.push({ text: match[2].trim(), checked: match[1].toLowerCase() === "x" });
    }
  }
  return items;
}

/**
 * T-0425 FIX ROUND: like parseAcceptanceCriteria, but reconstructs each criterion's FULL logical
 * text -- continuation lines included -- bounded at the next checkbox item or the next
 * heading/section, same as parseAcceptanceCriteria's own section boundary. parseAcceptanceCriteria
 * itself stays first-line-only on purpose: every run-time/reviewer-time reader
 * (impossibleAcceptancePreflight.js, reviewerPrompt.js) depends on that exact behaviour, and this
 * fix round changes none of it. This is a SEPARATE, author-time-only reader for
 * acceptanceVetPreflight.js's own checks, which need to see a criterion's whole text, not just its
 * opening line, to catch a conflict or a hardcoded count that only appears on a wrapped line.
 *
 * Two deliberate choices, stated here so they're decisions rather than accidents:
 * - A continuation line is NEVER treated as a new criterion based on its own shape -- only an
 *   actual `- [ ]`/`- [x]` match ends one. A nested bullet, a table row, or a fenced-code line is
 *   therefore captured as prose and joined onto the criterion above it.
 * - Fenced code-block content COUNTS as part of the criterion's text (not stripped) -- a path or
 *   command named only inside a fence is still real author-time signal; silently dropping it would
 *   just be a fresh blind spot of the same shape this function exists to close.
 * A blank/whitespace-only continuation line contributes nothing but does not end the criterion --
 * a later, non-blank continuation line still joins onto it.
 *
 * T-0425 FIX ROUND 2: a bare bold section label (e.g. `**Edge cases:**`) also bounds
 * reconstruction, the same as a heading or the next checkbox -- this is the real-card convention
 * for starting the edge-cases block right after the main checklist, and without this boundary the
 * label (and anything trailing it on the same line) gets absorbed into the PRECEDING criterion's
 * text. SECTION_LABEL_RE is anchored at the start of the trimmed line with the colon immediately
 * before the closing `**`, so it only matches a line-leading "**Label:**" shape -- mid-sentence
 * bold emphasis inside a real criterion ("Do **not** skip this step") does not match and keeps
 * joining as ordinary continuation prose.
 */
const SECTION_LABEL_RE = /^\*\*[^*]+:\*\*/;

export function parseAcceptanceCriteriaWithContinuations(body) {
  if (typeof body !== "string") {
    return [];
  }
  const lines = body.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => ACCEPTANCE_HEADING_RE.test(line.trim()));
  if (startIdx === -1) {
    return [];
  }
  const items = [];
  let current = null;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (HEADING_RE.test(line)) {
      break;
    }
    const match = CHECKBOX_RE.exec(line);
    if (match) {
      current = { text: match[2].trim(), checked: match[1].toLowerCase() === "x" };
      items.push(current);
    } else if (SECTION_LABEL_RE.test(line)) {
      current = null;
    } else if (current && line.length > 0) {
      current.text += ` ${line}`;
    }
  }
  return items;
}
