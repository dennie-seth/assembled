import { parseAcceptanceCriteria, CHECKBOX_RE } from "../lib/acceptanceCriteria.js";

const ACCEPTANCE_SECTION_RE = /^##\s+Acceptance\s*$/i;
const HEADING_RE = /^#{1,6}\s+/;
const EDGE_CASES_LABEL_RE = /^\*\*Edge cases:?\*\*/i;

/**
 * Warn-only pre-flight for the T-0186/T-0365 "cards ship without a planner-authored Edge cases
 * block" gap: `.claude/rules/planner.md` asks every card's `## Acceptance` section for a bold
 * `**Edge cases:**` sub-list but deliberately leaves it unenforced -- no VALIDATION gate FAILs a
 * card for omitting one. Cards created before that convention landed (68a359a, 2026-08-09) -- and
 * plenty created after it (T-0192/T-0193/T-0195/T-0198/T-0212-0215/T-0218 in this same backlog) --
 * ship with no edge-case coverage at all, so the first implementation pass has nothing forcing it
 * to consider boundary/failure conditions upfront. T-0365's own evidence (T-0065, T-0120, T-0122,
 * all created before 68a359a) shows the reviewer then discovers them one at a time across several
 * rework rounds instead: a boot-breaking duplicate-class_name regression, a missed returning-player
 * gate, an unsaved-session warning caught only on re-review, a duplicated clock-proximity formula.
 *
 * Mirrors impossibleAcceptancePreflight.js's contract exactly: never blocks (a false positive here
 * must never stop a legitimate card from running), returns `{ warnings: string[] }`, and is a no-op
 * when there's no parseable Acceptance section at all (acceptancePreflight.js's job, not this one's).
 *
 * planner.md requires more than the bold label: the block must be "followed by its own `- [ ]`
 * checklist items, one per edge case" (.claude/rules/planner.md:100-123). A bare `**Edge cases:**`
 * label with nothing underneath doesn't satisfy that convention, so it still warns.
 */
export function checkEdgeCasesPreflight(task) {
  const body = task?.body ?? "";
  const items = parseAcceptanceCriteria(body);
  if (items.length === 0) {
    return { warnings: [] };
  }

  const lines = body.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => ACCEPTANCE_SECTION_RE.test(line.trim()));
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
        "(.claude/rules/planner.md) -- the first implementation pass has nothing forcing it to " +
        "consider boundary/failure conditions upfront; expect the reviewer to surface them one " +
        "at a time across rework rounds instead."
    ]
  };
}
