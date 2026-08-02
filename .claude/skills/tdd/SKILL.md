---
name: tdd
description: The ordered design -> failing tests -> green -> refactor loop every implementer agent follows before handing a card to the reviewer. Encodes the project's Definition of Done.
---

# tdd

The loop every implementer agent (`infra`, `server`, `client`, `assets`,
`audio`) runs for every card, in order. Do not skip or reorder steps — the
`reviewer` agent checks for TDD evidence specifically (see the `review`
skill), and "tests added after the fact" fails that check even if the tests
themselves are correct.

## Steps

1. **Design.** Re-read the card's Context and Acceptance sections. Identify
   which interfaces/modules are touched, and whether anything in `shared/`
   needs to change first (if so, that's a dependency — flag it rather than
   duplicating a struct or template ID locally).
2. **Write the failing test cases first.** Cover the acceptance criteria
   directly, plus the edge cases implied by them (empty/malformed input,
   boundary values, concurrent access where relevant). Commit the test file
   before writing any implementation.
3. **Watch it fail.** Run the subsystem's test command and confirm the new
   tests fail for the expected reason — not a typo, not a missing import. A
   test that passes before the implementation exists is testing nothing;
   treat that as a bug in the test, not a shortcut.
4. **Implement to green.** Write the smallest change that makes the failing
   tests pass. Do not add functionality the tests don't require.
5. **Refactor.** With tests green, clean up naming, remove duplication,
   apply the path's rule file (SOLID/DRY, getters/setters, Doxygen for C++;
   typed GDScript for Godot; etc.) without changing behavior.

## Definition of Done (from `docs/PLAN.md`)

- [ ] Tests written first, passing.
- [ ] `docs/` updated if behavior or interface changed.
- [ ] No TODO without a task ID (`// TODO(T-0042): ...`).
- [ ] Ready for the `verify` skill, then `open-review-pr`.
