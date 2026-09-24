// T-0409: synthetic reproductions of the two real incidents the reviewer treated inconsistently --
// NOT copies of the live cards (T-0405 and T-0403 are never read or mutated by this run, per this
// card's own "Do not" list). What matters for the regression is the *shape* that broke the
// reviewer: one genuinely satisfiable criterion sitting alongside one criterion the running
// implementer agent structurally cannot ever satisfy.

// T-0405's shape: an infra card whose otherwise-satisfiable work also asked the implementer to
// edit files under `.claude/**` -- refused outright by the harness's sensitive-file protection in
// every unattended run (see tools/board/src/runner/toolAllowlist.js's CLAUDE_DIR_DENIAL_REASON),
// regardless of the agent or its grants.
export const T0405_CLAUDE_DIR_EDIT_BODY = `## Context

Tolerant \`## Acceptance\` heading parsing, reproducing T-0405's shape.

## Acceptance

- [ ] A qualified "## Acceptance (...)" heading is still parsed by \`parseAcceptanceCriteria\`.
- [ ] \`npx vitest run\` is green for the new regression coverage.
- [ ] \`.claude/rules/planner.md\` and \`.claude/agents/planner.md\` are edited to document the new tolerant heading convention.
`;

export const T0405_ITEM_COUNT = 3;
export const T0405_UNSATISFIABLE_ITEM_TEXT =
  "`.claude/rules/planner.md` and `.claude/agents/planner.md` are edited to document the new tolerant heading convention.";

// T-0403's shape: a db-mode card whose Acceptance section makes its own **Edge cases:** block a
// checkable criterion -- but a db-mode card body is only ever materialized to a worktree file
// during the planner phase (materializePlannerFileView), so an implementer has no card file to
// edit and no board-write grant to edit the body directly.
export const T0403_CARD_BODY_AUTHORSHIP_BODY = `## Context

Bottom-up spawn remap, reproducing T-0403's shape.

## Acceptance

- [ ] The spawn point is remapped bottom-up and covered by a passing gdUnit4 test.
- [ ] Door and ladder geometry stays walkable after the remap.
- [ ] An **Edge cases:** block, with its own \`- [ ]\` checklist items, is present in this card's own body.
`;

export const T0403_ITEM_COUNT = 3;
export const T0403_UNSATISFIABLE_ITEM_TEXT =
  "An **Edge cases:** block, with its own `- [ ]` checklist items, is present in this card's own body.";

// A card where EVERY item falls in the class -- the "nothing verifiable was delivered" edge case.
export const ALL_UNSATISFIABLE_BODY = `## Context

Every criterion on this card is structurally unsatisfiable by the running implementer.

## Acceptance

- [ ] \`.claude/agents/infra.md\` is updated to grant the new tool.
- [ ] A PR is opened with CI green before this card is considered done.
`;

export const ALL_UNSATISFIABLE_ITEM_COUNT = 2;
