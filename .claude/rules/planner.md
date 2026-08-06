---
paths: ["tasks/**"]
---

# Planner conventions

Loaded by the `planner` agent, and by `reviewer` whenever a diff touches
`tasks/**`. Governs how backlog cards get authored and audited — the
analog of `cpp.md`/`js.md`/etc. for `tasks/*.md` instead of source.

## Card-authoring quality

- Every card keeps the schema in `tools/board/src/lib/taskParser.js`:
  required frontmatter fields present, `id` matches `T-\d{4}`, `status` one
  of `backlog|ready|in-progress|validation|review|done|blocked`, `priority`
  one of `P0..P3`, `phase` an integer, `agent` one of the assignable agent
  names or `null`, `depends_on` an array of valid `T-NNNN` ids, `created` an
  `YYYY-MM-DD` string, and (optional, defaults to `code`)
  `deliverable_type` one of `code|artifact`.
- A card body has a `## Context` section (why this exists, grounded in a
  doc reference) and a `## Acceptance` section (checkable criteria) — the
  shape every existing card already follows (`docs/PLAN.md` §Task file
  schema).
- Under-specified is a defect: a Context section that just restates the
  title, or Acceptance criteria too vague to check off, is not acceptable
  planner output. Tighten it or leave a specific note about what's still
  unresolved and why.
- **Every acceptance criterion must be independently checkable by the
  reviewer** — `reviewerPrompt.js`'s `buildAcceptanceCriteriaSection` parses
  the `## Acceptance` checklist and requires the reviewer to confirm each
  item with concrete evidence, not infer it from green tests. A criterion
  like "it works" or "the script runs" is not acceptable; a criterion must
  name a specific, inspectable outcome.
- **Decide and record the card's `deliverable_type`.** Most cards are
  `code` (the default — leave the field unset). When a card's real output
  is a produced artifact — an asset, a doc, a fetched/generated file that
  gets attached to the ticket — set `deliverable_type: artifact` in its
  frontmatter, and write its Acceptance criteria to name the artifact
  itself and where it must end up (e.g. "T-0072's Attachments section shows
  the fetched corpus images"), never the mechanism that could produce it
  (e.g. not "an uploader script exists and its tests pass"). This is the
  T-0136 lesson: an uploader CLI shipped with fully mocked tests, ruff+pytest
  green, and not a single image was ever actually fetched or attached —
  nothing in the card's own Acceptance section or in VALIDATION at the time
  distinguished "capable of producing the artifact" from "produced it."
  `tools/board/src/lib/deliverableCheck.js` and
  `tools/board/scripts/checkDeliverable.js` are the reviewer's machine-checked
  gate for `artifact` cards — they FAIL a card with no attachments recorded,
  or a recorded attachment with no backing file on disk.

## Grounding in docs

- Every rewrite, split, or new card cites the specific design-doc section
  that justifies it — `docs/PLAN.md` phase/task table, or a
  `docs/design/NN-*.md` section, or `docs/HANDOFF.md`/`docs/GDD-*.md` where
  those are the source of truth for that content. No scope invented beyond
  what a doc actually says; "seems like a good idea" is not grounding.
- If two docs disagree, don't silently pick one — flag the conflict in the
  card body (or the planner's own run summary) instead of guessing.

## Schema and dependency hygiene

- IDs are gap-tolerant and never reused, allocated as the next `T-NNNN`
  after the highest id currently present in `tasks/` — same algorithm as
  `tools/board/src/lib/idAllocator.js`. Splitting a card retires its
  original id (in-body note) rather than reusing it for one of the pieces.
- `depends_on` entries must resolve to an existing card, contain no
  duplicates, and never form a cycle (direct or transitive) — this is
  machine-checked by the backlog validator
  (`tools/board/scripts/validateBacklog.js`), the gate every planner run
  must pass before a human sees it.

## Guardrails — never violate these

- **Never touch `status`.** It's runtime state owned by the Agent Runner
  and, ultimately, a human (`docs/design/agent-runner.md` Lifecycle). A
  planner diff that changes any card's `status` field is invalid regardless
  of what else it gets right.
- **Never delete a card.** Mark it obsolete/superseded in-body instead —
  history over tidiness.
- **Never mark anything `done`, never merge, never push.** Same invariant
  every other agent follows (`conduct.md`): `review` is the terminal state
  automation can reach.

These two are no longer prose the planner or reviewer have to remember to
check by eye: `tools/board/src/lib/plannerDiffGuard.js` machine-checks both,
comparing each `tasks/*.md` card's old and new `status` (via `taskParser`)
and flagging any card file that disappears from the diff. `reviewer` runs it
(`node tools/board/scripts/checkPlannerDiffGuard.js <baseBranch>`) as part of
the `tasks/**` VALIDATION route alongside the backlog validator
(`verifyRouter.js`) — a violation is an automatic FAIL, not a judgment call.
The planner itself can and should run the same command before handing off
(`.claude/agents/planner.md` Workflow step 4) — it has narrow Bash access to
exactly this and the backlog validator, nothing else.
