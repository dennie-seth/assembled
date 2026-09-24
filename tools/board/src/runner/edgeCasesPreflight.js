import { parseAcceptanceCriteria } from "../lib/acceptanceCriteria.js";
import { hasEdgeCasesBlock } from "../lib/edgeCasesAudit.js";

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
 * T-0405: the section-start scan used to re-derive its own strict `^##\s+Acceptance\s*$` regex
 * instead of reusing acceptanceCriteria.js's `ACCEPTANCE_HEADING_RE`. Once that regex became
 * tolerant of a qualified heading ("## Acceptance (story-level -- planner expands)"), this file's
 * separate copy would still fail to find the section for the exact same body -- items.length > 0
 * from parseAcceptanceCriteria, but startIdx stayed -1 here, so a card missing its Edge cases block
 * under a qualified heading silently got no warning at all. Importing the one regex both places
 * use closes that gap the same way vetAndReady.js's does (see acceptanceCriteria.js).
 *
 * T-0408: the block-detection scan itself (find the label, then a checklist item under it before
 * the next heading) now lives in `hasEdgeCasesBlock` (lib/edgeCasesAudit.js), shared with the
 * board-wide `auditEdgeCasesCoverage` re-run -- so "does this card have a real block" can never
 * quietly diverge between the per-card warning and the board-wide count.
 */
export function checkEdgeCasesPreflight(task) {
  const body = task?.body ?? "";
  const items = parseAcceptanceCriteria(body);
  if (items.length === 0) {
    return { warnings: [] };
  }

  if (hasEdgeCasesBlock(body)) {
    return { warnings: [] };
  }

  return {
    warnings: [
      "## Acceptance has no **Edge cases:** block with its own `- [ ]` checklist items " +
        "(.claude/rules/planner.md) -- a compliant block adds a bold `**Edge cases:**` line " +
        "under `## Acceptance`, followed by its own `- [ ] ...` item(s), one per edge case."
    ]
  };
}
