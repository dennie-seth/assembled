const SECTION_RE = /^##\s+Acceptance\s*$/i;
const HEADING_RE = /^#{1,6}\s+/;
const CHECKBOX_RE = /^-\s*\[([ xX])\]\s*(.+)$/;

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
  const startIdx = lines.findIndex((line) => SECTION_RE.test(line.trim()));
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
