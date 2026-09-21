import { describe, it, expect } from "vitest";
import { parseAcceptanceCriteria } from "../src/lib/acceptanceCriteria.js";

describe("parseAcceptanceCriteria", () => {
  it("extracts unchecked checkbox items under ## Acceptance", () => {
    const body = "## Context\nSomething.\n\n## Acceptance\n- [ ] first thing\n- [ ] second thing\n";
    expect(parseAcceptanceCriteria(body)).toEqual([
      { text: "first thing", checked: false },
      { text: "second thing", checked: false }
    ]);
  });

  it("marks checked items ([x] or [X]) as checked: true", () => {
    const body = "## Acceptance\n- [x] done one\n- [X] done two\n- [ ] not done\n";
    expect(parseAcceptanceCriteria(body)).toEqual([
      { text: "done one", checked: true },
      { text: "done two", checked: true },
      { text: "not done", checked: false }
    ]);
  });

  it("returns [] when there is no Acceptance section at all", () => {
    expect(parseAcceptanceCriteria("## Context\nJust context, no acceptance.\n")).toEqual([]);
  });

  it("returns [] for an empty body", () => {
    expect(parseAcceptanceCriteria("")).toEqual([]);
  });

  it("returns [] for a non-string body", () => {
    expect(parseAcceptanceCriteria(undefined)).toEqual([]);
    expect(parseAcceptanceCriteria(null)).toEqual([]);
  });

  it("stops at the next ## heading and ignores content after it", () => {
    const body =
      "## Acceptance\n- [ ] in scope\n\n## Validation: PASS (2026-08-04)\n- [ ] not an AC, a stray checkbox in a validation note\n";
    expect(parseAcceptanceCriteria(body)).toEqual([{ text: "in scope", checked: false }]);
  });

  it("ignores non-checkbox lines within the Acceptance section", () => {
    const body = "## Acceptance\nSome prose explaining context.\n- [ ] the actual criterion\n";
    expect(parseAcceptanceCriteria(body)).toEqual([{ text: "the actual criterion", checked: false }]);
  });

  it("trims surrounding whitespace from criterion text", () => {
    const body = "## Acceptance\n-   [ ]    padded text   \n";
    expect(parseAcceptanceCriteria(body)).toEqual([{ text: "padded text", checked: false }]);
  });

  it("matches the real T-0136 card's Acceptance section shape", () => {
    const body =
      "As the LoRA pipeline...\n\n## Acceptance\n\n- [ ] T-0072's Attachments section shows the fetched corpus images\n";
    expect(parseAcceptanceCriteria(body)).toEqual([
      { text: "T-0072's Attachments section shows the fetched corpus images", checked: false }
    ]);
  });
});

// T-0405: a qualified heading ("## Acceptance (story-level -- planner expands)", "## Acceptance
// criteria", ...) used to parse as having NO acceptance section at all -- SECTION_RE required an
// exact "## Acceptance" with nothing but trailing whitespace after it ($ right after \s*). That
// hard-blocked T-0403 twice at run preflight even though its checklist was well-formed. These
// cases pin the fix's ACCEPT side: a qualified heading yields the identical items a bare
// "## Acceptance" would.
describe("parseAcceptanceCriteria -- tolerates a qualified heading (T-0405, the T-0403 failure mode)", () => {
  const EXPECTED = [
    { text: "first thing", checked: false },
    { text: "second thing", checked: false }
  ];
  const CHECKLIST = "- [ ] first thing\n- [ ] second thing\n";

  const ACCEPTED_HEADINGS = [
    "## Acceptance (story-level -- planner expands)",
    "## Acceptance criteria",
    "## Acceptance (final)",
    "## Acceptance:"
  ];

  for (const heading of ACCEPTED_HEADINGS) {
    it(`accepts "${heading}" and parses the checklist beneath it unchanged`, () => {
      const body = `## Context\nSomething.\n\n${heading}\n${CHECKLIST}`;
      expect(parseAcceptanceCriteria(body)).toEqual(EXPECTED);
    });
  }

  it("still stops at the next heading with a qualified heading, same as a bare one", () => {
    const body =
      "## Acceptance (story-level -- planner expands)\n- [ ] in scope\n\n## Validation: PASS (2026-08-04)\n- [ ] not an AC, a stray checkbox in a validation note\n";
    expect(parseAcceptanceCriteria(body)).toEqual([{ text: "in scope", checked: false }]);
  });

  it("still honors checked/unchecked state with a qualified heading", () => {
    const body = "## Acceptance criteria\n- [x] done one\n- [ ] not done\n";
    expect(parseAcceptanceCriteria(body)).toEqual([
      { text: "done one", checked: true },
      { text: "not done", checked: false }
    ]);
  });
});

// The bounded side of the same fix: tolerance is NOT "any heading that mentions the word
// acceptance anywhere." The heading text must BEGIN with the word "Acceptance" -- a heading that
// merely mentions it, or glues a suffix straight onto the word with no separating space/punctuation
// ("Acceptance-adjacent"), is a different heading and must still parse as having no acceptance
// section (returns []).
describe("parseAcceptanceCriteria -- does NOT treat an acceptance-adjacent heading as the section (T-0405 boundary)", () => {
  const REJECTED_HEADINGS = ["## Notes on Acceptance", "## Acceptance-adjacent notes", "## How acceptance is judged"];

  for (const heading of REJECTED_HEADINGS) {
    it(`rejects "${heading}" -- returns [] just like a body with no Acceptance section`, () => {
      const body = `## Context\nSomething.\n\n${heading}\n- [ ] first thing\n- [ ] second thing\n`;
      expect(parseAcceptanceCriteria(body)).toEqual([]);
    });
  }
});

// Heading level: this repo's cards always use h2 (## Acceptance), but vetAndReady.js's own
// tolerant parse of the same section accepts any level 1-6 (#{1,6}). Accepting the same range here
// closes the divergence rather than reopening it at a different axis (heading level instead of
// suffix) -- see the shared agreement table in test/lib/acceptanceHeadingAgreement.test.js.
describe("parseAcceptanceCriteria -- heading level (agrees with vetAndReady.js's #{1,6})", () => {
  it("accepts h2, the repo's own convention", () => {
    expect(parseAcceptanceCriteria("## Acceptance\n- [ ] x\n")).toEqual([{ text: "x", checked: false }]);
  });

  it("accepts h1", () => {
    expect(parseAcceptanceCriteria("# Acceptance\n- [ ] x\n")).toEqual([{ text: "x", checked: false }]);
  });

  it("accepts h3", () => {
    expect(parseAcceptanceCriteria("### Acceptance\n- [ ] x\n")).toEqual([{ text: "x", checked: false }]);
  });

  it("accepts h6, the deepest level vetAndReady.js's own regex accepts", () => {
    expect(parseAcceptanceCriteria("###### Acceptance\n- [ ] x\n")).toEqual([{ text: "x", checked: false }]);
  });
});

describe("parseAcceptanceCriteria -- edge cases (T-0405)", () => {
  it("first match wins when a body has two acceptance-ish headings", () => {
    const body =
      "## Acceptance\n- [ ] real one\n\n## Acceptance (duplicate)\n- [ ] should not appear\n";
    expect(parseAcceptanceCriteria(body)).toEqual([{ text: "real one", checked: false }]);
  });

  // The parser scans raw lines and has no concept of Markdown fencing -- it never tokenizes the
  // body into blocks. A "## Acceptance" line inside a fenced code block is therefore still matched
  // like any other heading line (first match wins, same as the case above); this pins that as the
  // deliberate, documented current behavior rather than a silent surprise, not a request to make
  // this parser fence-aware (out of scope for this card).
  it("does not skip a heading-shaped line inside a fenced code block (parser is not fence-aware)", () => {
    const body =
      "## Context\n```\n## Acceptance\n- [ ] fake, inside a fence\n```\n\n## Acceptance\n- [ ] real one\n";
    expect(parseAcceptanceCriteria(body)).toEqual([{ text: "fake, inside a fence", checked: false }]);
  });

  it("handles CRLF line endings", () => {
    const body = "## Context\r\nSomething.\r\n\r\n## Acceptance (final)\r\n- [ ] first thing\r\n- [ ] second thing\r\n";
    expect(parseAcceptanceCriteria(body)).toEqual([
      { text: "first thing", checked: false },
      { text: "second thing", checked: false }
    ]);
  });

  it("tolerates trailing whitespace on the heading line", () => {
    const body = "## Acceptance   \n- [ ] first thing\n";
    expect(parseAcceptanceCriteria(body)).toEqual([{ text: "first thing", checked: false }]);
  });

  it("tolerates a heading suffix that itself contains a '#'", () => {
    const body = "## Acceptance (see also #123)\n- [ ] first thing\n";
    expect(parseAcceptanceCriteria(body)).toEqual([{ text: "first thing", checked: false }]);
  });

  it("parses correctly when the Acceptance section is the very last thing in the body, no following heading", () => {
    const body = "## Context\nSomething.\n\n## Acceptance criteria\n- [ ] first thing\n- [ ] second thing";
    expect(parseAcceptanceCriteria(body)).toEqual([
      { text: "first thing", checked: false },
      { text: "second thing", checked: false }
    ]);
  });
});

describe("parseAcceptanceCriteria -- nothing gets looser than intended (T-0405 regression guard)", () => {
  it("still returns [] for a body with no acceptance section at all", () => {
    expect(parseAcceptanceCriteria("## Context\nJust context, no acceptance.\n")).toEqual([]);
  });

  it("still returns [] when the Acceptance section has prose but no checkboxes, qualified heading included", () => {
    const body = "## Acceptance (final)\n\nsome prose but no checkboxes\n";
    expect(parseAcceptanceCriteria(body)).toEqual([]);
  });
});
