// T-0405: a trimmed, synthetic reproduction of T-0403's body shape -- NOT a copy of the live card
// (that card is never read or mutated by this run, per T-0405's "Do not" list). What matters for
// the regression is the shape that broke preflight: a "## Acceptance" heading carrying a
// parenthetical qualifier, 8 checkbox items below it, and a "**Edge cases:**" item among them.
export const T0403_ACCEPTANCE_BODY = `## Context

Some card whose acceptance heading carries a story-level qualifier, reproducing T-0403's shape.

## Acceptance (story-level -- planner expands)

- [ ] First criterion, independently checkable.
- [ ] Second criterion, independently checkable.
- [ ] Third criterion, independently checkable.
- [ ] Fourth criterion, independently checkable.
- [ ] Fifth criterion, independently checkable.
- [ ] Sixth criterion, independently checkable.
- [ ] Seventh criterion, independently checkable.
- [ ] **Edge cases:** boundary and missing-input cases are covered by their own checklist items.
`;

export const T0403_ACCEPTANCE_ITEM_COUNT = 8;
