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
const HEADING_RE = /^#{1,6}\s+/;
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
