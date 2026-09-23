import { parseAcceptanceCriteria, CHECKBOX_RE, ACCEPTANCE_HEADING_RE } from "../lib/acceptanceCriteria.js";

const HEADING_RE = /^#{1,6}\s+/;
const EDGE_CASES_LABEL_RE = /^\*\*Edge cases:?\*\*/i;

/**
 * Warn-only pre-flight for the T-0186/T-0365 "cards ship without a planner-authored Edge cases
 * block" gap: `.claude/rules/planner.md` asks every card's `## Acceptance` section for a bold
 * `**Edge cases:**` sub-list but deliberately leaves it unenforced -- no VALIDATION gate FAILs a
 * card for omitting one. Cards created before that convention landed (68a359a, 2026-08-09) -- and
 * plenty created after it (T-0192/T-0193/T-0195/T-0198/T-0212-0215/T-0218 in this same backlog) --
 * ship with no edge-case coverage at all. That much is a confirmed observation.
 *
 * What is NOT confirmed: that this gap caused T-0365's own rework-rate evidence. T-0065, T-0120
 * and T-0122 (T-0365's cited evidence, all created before 68a359a) do lack the block, but their
 * archived FAIL/Blocked notes name five separate causes unrelated to it -- an inherited flaky-port
 * timeout test, an unimplemented "readable labels" acceptance clause, a boot-breaking duplicate
 * `class_name` plus missing integration wiring, an identity-overwrite/blank-screen regression only
 * a real-scene load caught, and a DRY violation the reviewer flagged despite a passing suite (see
 * tasks/T-0365.md's "FIX ROUND 1" section for the quoted notes). None of the five reads as "the
 * first pass never considered an edge case it should have." This preflight is a planning-warning
 * *experiment* on the strength of the observed correlation, not a fix tied to a demonstrated
 * failure mechanism -- the rework-rate root cause itself remains unidentified.
 *
 * Mirrors impossibleAcceptancePreflight.js's contract exactly: never blocks (a false positive here
 * must never stop a legitimate card from running), returns `{ warnings: string[] }`, and is a no-op
 * when there's no parseable Acceptance section at all (acceptancePreflight.js's job, not this one's).
 *
 * planner.md requires more than the bold label: the block must be "followed by its own `- [ ]`
 * checklist items, one per edge case" (.claude/rules/planner.md:100-123). A bare `**Edge cases:**`
 * label with nothing underneath doesn't satisfy that convention, so it still warns.
 *
 * T-0405: the section-start scan below used to re-derive its own strict `^##\s+Acceptance\s*$`
 * regex instead of reusing acceptanceCriteria.js's `ACCEPTANCE_HEADING_RE`. Once that regex became
 * tolerant of a qualified heading ("## Acceptance (story-level -- planner expands)"), this file's
 * separate copy would still fail to find the section for the exact same body -- items.length > 0
 * from parseAcceptanceCriteria, but startIdx stayed -1 here, so a card missing its Edge cases block
 * under a qualified heading silently got no warning at all. Importing the one regex both places
 * use closes that gap the same way vetAndReady.js's does (see acceptanceCriteria.js).
 */
export function checkEdgeCasesPreflight(task) {
  const body = task?.body ?? "";
  const items = parseAcceptanceCriteria(body);
  if (items.length === 0) {
    return { warnings: [] };
  }

  const lines = body.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => ACCEPTANCE_HEADING_RE.test(line.trim()));
  if (startIdx === -1) {
    return { warnings: [] };
  }

  let labelIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (HEADING_RE.test(line)) break;
    if (EDGE_CASES_LABEL_RE.test(line)) {
      labelIdx = i;
      break;
    }
  }

  if (labelIdx !== -1) {
    for (let i = labelIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (HEADING_RE.test(line)) break;
      if (CHECKBOX_RE.test(line)) {
        return { warnings: [] };
      }
    }
  }

  return {
    warnings: [
      "## Acceptance has no **Edge cases:** block with its own `- [ ]` checklist items " +
        "(.claude/rules/planner.md) -- a compliant block adds a bold `**Edge cases:**` line " +
        "under `## Acceptance`, followed by its own `- [ ] ...` item(s), one per edge case."
    ]
  };
}
