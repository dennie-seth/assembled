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
5. **Commit the implementation now, before refactoring or self-verifying.**
   `git add -A && git commit` the GREEN state as its own commit as soon as
   it's written. Do not defer this until after step 6 or after the `verify`
   skill runs — self-verification can eat many turns chasing an unrelated
   tool/permission/environment problem, and an implementation left
   uncommitted while that happens is one crash or one dropped turn away from
   being lost entirely, with nothing on the branch to show for it. Commit
   first, then refactor/verify; a small follow-up commit for refactor or
   verify-driven fixes is normal and fine.
6. **Refactor.** With tests green, clean up naming, remove duplication,
   apply the path's rule file (SOLID/DRY, getters/setters, Doxygen for C++;
   typed GDScript for Godot; etc.) without changing behavior. Commit any
   resulting changes.
7. **Confirm the worktree is clean.** Run `git status --porcelain` and
   confirm it prints nothing. If it doesn't, you have uncommitted work —
   commit it before you stop. This is the actual Definition of Done, not the
   acceptance criteria alone: the reviewer only ever sees committed history,
   and uncommitted work is invisible to it.

## Definition of Done (from `docs/PLAN.md`)

- [ ] Tests written first, passing.
- [ ] Implementation committed (not just written — `git status --porcelain`
      is empty).
- [ ] `docs/` updated if behavior or interface changed.
- [ ] No TODO without a task ID (`// TODO(T-0042): ...`).
- [ ] Ready for the `verify` skill. Do NOT run `open-review-pr` yourself —
      an Agent Runner orchestrator drives the handoff to the reviewer's
      VALIDATION pass and pushes only after that verdict is PASS. That skill
      exists for interactive/manual use outside the orchestrator, not for
      agents running under it.
