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
  `YYYY-MM-DD` string, (optional, defaults to `code`) `deliverable_type` one
  of `code|artifact`, and (optional, defaults to `false`) `requires_approval`
  a boolean.
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
  or a recorded attachment with no backing file on disk. **Set this correctly
  even though a diff-based backstop now also exists:** several `assets`/
  `audio` cards whose real output was a shareable file (T-0198-T-0200,
  T-0209-T-0211, T-0202) were tagged `deliverable_type: "code"` instead,
  which is exactly the misclassification `verifyRouter.js`'s
  `resolveDeliverableRoute` now also catches mechanically (any diff adding a
  file under `assets/final/**`, `assets/src/concept/**`, or
  `assets/src/keyart/**` requires an attachment regardless of what this
  field says). That backstop is a safety net for a missed classification,
  not a reason to skip setting the field right — an accurate
  `deliverable_type: artifact` is still what drives the reviewer's own
  Acceptance-criteria wording above.
- **Set `requires_approval: true` on every direction card.** A *direction*
  card is one whose real deliverable is a choice a human has to sign off on
  before other work is generated against it: concept art, a style or palette
  sheet, a reference sheet, a chosen visual/audio direction. The flag makes a
  reviewer PASS **park** the card in `review` (with a `PARKED FOR HUMAN
  APPROVAL` comment) instead of leaving it completable by anyone — and since
  `dependencyGuard` only counts `done`/`retired`, its dependents stay blocked
  until a human actually approves. See `docs/board-invariants.md` §10 for the
  mechanism and the T-0239 incident that motivated it (an unapproved synthetic
  concept sheet reached `done` and unblocked T-0243).
  **Write the Acceptance to describe producing and parking, never getting
  approved.** "The card parks awaiting a human verdict, with no approval record
  written by the agent" is checkable; "@DennieSeth approves the sheet" is not a
  criterion any agent can satisfy, and writing it as one is what made T-0233
  unsatisfiable across five attempts. Never write `approved_by`/`approved_at`
  into a card file — those are the server's to write when a human approves,
  and `checkPlannerDiffGuard` fails a planner run that touches them.
- **Acceptance criteria must fully cover the story, not just whatever got
  drafted first.** After writing `## Acceptance`, walk back through the
  card's story and confirm every distinct requirement it states or clearly
  implies maps to a criterion — add one for anything missing, or note
  explicitly why it's out of scope, but don't invent requirements the story
  never asked for (gold-plating is a defect too). A story naming multiple
  cases, directions, or states ("scroll right and left", "create and
  delete", "mobile and desktop") needs a criterion per case, never one
  bullet that silently covers only one side of it. Favor criteria that
  assert observable behavior over a static property being set. This is the
  T-0141 lesson: the story asked for the side-panel overlay to "scroll
  right and left to see [cards] properly," but the Acceptance section that
  shipped only had "`.board` has `overflow-x: auto`" — a CSS-property
  check that passes trivially and proves nothing about whether every
  column is actually reachable in both directions once the panel is open.
  The implementer and reviewer both faithfully satisfied that criterion —
  unlike T-0136, where the AC wasn't checked against the deliverable at
  all, here the AC *was* checked and still incomplete — while the
  bidirectional-scroll requirement itself shipped broken. A behavioral
  criterion would instead read "with the panel open, every column remains
  reachable by scrolling both left and right, regardless of column count."
- **Every card's `## Acceptance` gets an explicit `**Edge cases:**` block —
  a strong expectation, not a hard gate.** Right after drafting the main
  criteria, add a bold-label `**Edge cases:**` line (never a `#`/`##`/`###`
  heading — `parseAcceptanceCriteria`
  (`tools/board/src/lib/acceptanceCriteria.js`) stops scanning `##
  Acceptance` at the first heading of *any* level, so a markdown
  subheading here would silently drop every item under it from the
  reviewer's acceptance-criteria audit) followed by its own `- [ ]`
  checklist items, one per edge case, boundary condition, or failure mode
  this specific card's own logic has to handle. Derive them from the card
  — boundary/limit values, missing/null/malformed input, an error or
  failure path, concurrent or duplicate operations on shared state, invalid
  input — not from a generic boilerplate list; skip a category that
  genuinely doesn't apply rather than inventing a meaningless item. The
  planner's own step-5 self-check (`buildPlannerPrompt`'s
  `PLANNER_EXPANSION_WORKFLOW`) then verifies the block the same way it
  verifies story coverage: present, concrete, card-specific, tied to a
  checkable criterion. This is deliberately **not** a new machine-checked
  gate like `plannerDiffGuard.js` — there is no VALIDATION check that FAILs
  a card for a missing or thin Edge cases block, and the implementer is
  never blocked from starting a card that lacks one. Once written inside
  `## Acceptance`, edge cases are ordinary criteria to the reviewer's
  existing `buildAcceptanceCriteriaSection` audit (`reviewerPrompt.js`) —
  no separate enforcement mechanism was added or is needed.

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
