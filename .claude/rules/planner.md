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
  `YYYY-MM-DD` string.
- A card body has a `## Context` section (why this exists, grounded in a
  doc reference) and a `## Acceptance` section (checkable criteria) — the
  shape every existing card already follows (`docs/PLAN.md` §Task file
  schema).
- Under-specified is a defect: a Context section that just restates the
  title, or Acceptance criteria too vague to check off, is not acceptable
  planner output. Tighten it or leave a specific note about what's still
  unresolved and why.

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
