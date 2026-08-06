---
name: review
description: The reviewer agent's VALIDATION checklist — run verify, audit the diff against path rules and conduct.md, emit a PASS/FAIL verdict with specific notes, and set the card to review (pass) or in-progress (fail).
---

# review

The `reviewer` agent's procedure for the `VALIDATION` lifecycle state (see
`docs/design/07-agent-runner.md`). Read-only on source — this skill never
edits production code, only the card's status and notes.

## Steps

1. **Run `verify`** for the paths the card's diff touches. If it can't even
   run (broken environment, missing tool), stop here and set the card to
   `blocked` with the reason — that is not a FAIL verdict, it's a runner
   failure.
2. **Load the applicable rules.** `.claude/rules/conduct.md` always, plus
   whichever of `cpp.md` / `js.md` / `godot.md` / `sql.md` / `assets.md` /
   `planner.md` match the changed paths.
3. **Audit the diff** (`git diff develop...HEAD`) against those rules:
   - TDD evidence: was the test file committed before/alongside the
     implementation, and does it actually exercise the acceptance criteria
     — not just a happy-path smoke test? (Not applicable to a `planner`
     diff — its "tests" are the backlog validator, covered above.)
   - `conduct.md`: no free-text UGC surface added; commit carries the
     `Co-authored-by: Claude` trailer; branch is `feature/T-NNNN-*` off
     `develop`; any generated asset has an `ASSET_PROVENANCE.md` entry.
   - Path-specific: SOLID/DRY, getters/setters, Doxygen coverage for C++;
     typed GDScript and gdUnit4 coverage for `godot.md` paths; up/down
     idempotency for `sql.md` paths; license allowlist + provenance for
     `assets.md` paths.
   - `planner.md` (`tasks/**` diffs — see `.claude/rules/planner.md`): no
     card's `status` field changed from the base branch (diff the frontmatter,
     not just the body — `status` is runtime state the planner must never
     touch); no card was deleted (an obsolete card gets an in-body note
     instead, the file stays); every rewritten/new card cites a specific
     `docs/` reference, not invented scope; new ids follow the gap-tolerant
     `T-NNNN` scheme with no reuse.
4. **Audit the card's own Acceptance criteria and deliverable — separately
   from `verify` passing.** `verify` going green is not a verdict on its
   own; it says the check discipline was followed, not that the card's
   acceptance criteria were met.
   - Work through the card's `## Acceptance` checklist one criterion at a
     time (`reviewerPrompt.js` puts this list directly in your prompt via
     `buildAcceptanceCriteriaSection`). For each, cite concrete evidence —
     a command you ran, a file you inspected — not "the code looks
     correct." Any single unmet or unconfirmable criterion is a FAIL for
     the whole card. A card with no parseable Acceptance section at all is
     also a FAIL, not a skipped check.
   - Distrust a test that mocks away the very side effect a criterion
     requires (e.g. mocked `urllib`/`requests` so no real network call,
     file write, or upload ever happens) — a green suite built entirely on
     such mocks proves the code *could* satisfy the criterion, not that it
     *did*.
   - If the card's `deliverable_type` is `artifact` (its real output is a
     produced file — an asset, a doc, an attached image — not the code
     that creates one), run
     `node tools/board/scripts/checkDeliverable.js <id>` and treat a
     nonzero exit as a FAIL naming the missing artifact. This is the
     T-0136 gap: an uploader CLI shipped with fully mocked tests,
     ruff+pytest green, and not one image was ever actually fetched or
     attached — nothing checked for the attachment itself.
5. **Emit a verdict.**
   - **PASS** — `verify` green and the audit finds nothing disqualifying.
     Move the card to `review`, attach a short summary of what was checked.
   - **FAIL** — either `verify` is red, or the audit finds a rule
     violation. Move the card back to `in-progress` with specific notes:
     cite file and line, name the rule violated, don't just say "needs
     work."

## Hard stop

Never move a card to `done`. Never merge the PR. A PASS verdict's terminal
action is `review` — the human is the only actor that can advance
`review` -> `done`.
