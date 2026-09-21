import { describe, it, expect } from "vitest";
import { parseAcceptanceCriteria } from "../../src/lib/acceptanceCriteria.js";
import { ACCEPTANCE_SECTION_RE } from "../../src/lib/vetAndReady.js";

/**
 * T-0405: the board disagreed with itself about what counts as "the" Acceptance heading --
 * acceptanceCriteria.js's parseAcceptanceCriteria required an exact "## Acceptance" with nothing
 * but trailing whitespace after it, while vetAndReady.js's ACCEPTANCE_SECTION_RE already tolerated
 * any heading level and any suffix. A card the nightly vet-and-ready job happily readied could then
 * be hard-blocked at run preflight for the very same heading (T-0403, T-0396).
 *
 * Both regexes are now built from the same heading-text rule (see acceptanceCriteria.js's
 * ACCEPTANCE_HEADING_TEXT_SRC, imported by vetAndReady.js), so this table asserts the two parsers
 * can no longer diverge: for every heading spelling below, parseAcceptanceCriteria's "found a
 * section" verdict and vetAndReady's ACCEPTANCE_SECTION_RE.test() verdict agree exactly.
 */
const HEADING_TABLE = [
  { heading: "## Acceptance", agrees: true },
  { heading: "## acceptance", agrees: true },
  { heading: "## ACCEPTANCE", agrees: true },
  { heading: "## Acceptance (story-level -- planner expands)", agrees: true },
  { heading: "## Acceptance criteria", agrees: true },
  { heading: "## Acceptance (final)", agrees: true },
  { heading: "## Acceptance:", agrees: true },
  { heading: "# Acceptance", agrees: true },
  { heading: "### Acceptance", agrees: true },
  { heading: "###### Acceptance", agrees: true },
  { heading: "## Notes on Acceptance", agrees: false },
  { heading: "## Acceptance-adjacent notes", agrees: false },
  { heading: "## How acceptance is judged", agrees: false }
];

function hasAcceptanceSection(body) {
  return parseAcceptanceCriteria(body).length > 0;
}

describe("acceptanceCriteria.js and vetAndReady.js agree on what counts as the Acceptance heading (T-0405)", () => {
  for (const { heading, agrees } of HEADING_TABLE) {
    it(`"${heading}" -- both accept: ${agrees}`, () => {
      const body = `${heading}\n- [ ] a checklist item\n`;
      const parseAccepts = hasAcceptanceSection(body);
      const vetAcceptsSection = ACCEPTANCE_SECTION_RE.test(body);

      expect(parseAccepts).toBe(agrees);
      expect(vetAcceptsSection).toBe(agrees);
      expect(parseAccepts).toBe(vetAcceptsSection);
    });
  }

  it("never disagrees anywhere in the table, checked as a single guard assertion", () => {
    const disagreements = HEADING_TABLE.map(({ heading }) => {
      const body = `${heading}\n- [ ] a checklist item\n`;
      const parseAccepts = hasAcceptanceSection(body);
      const vetAccepts = ACCEPTANCE_SECTION_RE.test(body);
      return { heading, parseAccepts, vetAccepts, agree: parseAccepts === vetAccepts };
    }).filter((entry) => !entry.agree);

    expect(disagreements).toEqual([]);
  });
});
