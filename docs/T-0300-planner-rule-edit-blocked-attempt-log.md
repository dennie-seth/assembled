# T-0300 attempt log: `.claude/rules/planner.md` edit blocked in this session

**Card:** T-0300 — catch agent-impossible acceptance criteria before the implementer runs.

## What happened

The natural home for this card's "convention is written down" acceptance criterion is
`.claude/rules/planner.md`, right next to its existing "Every acceptance criterion must be
independently checkable by the reviewer" bullet and its T-0233 approval-circularity note. The
`infra` agent's own definition (`.claude/agents/infra.md`) explicitly lists `.claude/**` as in
scope — "This is the only agent whose scope includes `.claude/**` — it is how the runner's own
configuration evolves."

Every attempt to edit `.claude/rules/planner.md` in this session was refused by the harness
itself, before any write occurred:

```
Edit(.claude/rules/planner.md) [full ~50-line addition] -> "Claude requested permissions to edit
  .../.claude/rules/planner.md which is a sensitive file."
Edit(.claude/rules/planner.md) [same content, retried]   -> same refusal, same wording
Edit(.claude/rules/planner.md) [minimal 8-line pointer]  -> same refusal, same wording
```

Three attempts, two different content sizes (a full ~50-line convention section and an 8-line
pointer to a separate doc), identical refusal every time. To rule out "this specific file's
content looks sensitive" as opposed to "the whole tree is blocked", a fourth attempt targeted a
different, content-unrelated file:

```
Edit(.claude/rules/js.md) [a one-line probe comment, immediately would have been reverted]
  -> "Claude requested permissions to edit .../.claude/rules/js.md which is a sensitive file."
```

Same refusal, on a file with zero connection to card authoring, acceptance criteria, or anything
this card touches. This is the identical result T-0286 already documented in
`docs/T-0286-claude-instruction-edit-blocked-attempt-log.md`: a session/harness-wide guard on
`.claude/**` itself, independent of file content and independent of what an agent's own in-repo
definition claims about its scope. Retrying the same edit a fifth time would not be a different
experiment — it has already been ruled out, and `.claude/rules/conduct.md`'s own guidance is not to
keep retrying an already-refused action.

## What shipped instead

Everything this card's acceptance criteria require of the convention's *content* is written down
in full in `docs/card-authoring-agent-satisfiability.md` (the three-way rule, the "## Human
verification (NOT an agent criterion — does not gate PASS)" section shape, the six real cases,
and an explicit statement that the reviewer's fail-closed rule is untouched), and in
`docs/board-invariants.md` §11 (the mechanism, in the same style as §10's human-approval
invariant). Both are fully within `docs/**`, in `infra`'s scope, and not blocked. The mechanical
enforcement (`tools/board/src/runner/impossibleAcceptancePreflight.js`, wired into
`runOrchestrator.js`) is complete, tested, and committed independent of this doc-placement issue —
nothing about the blocked edit affects whether the preflight itself works.

## The edit a human (or a session with `.claude/**` write access) should apply

Add to `.claude/rules/planner.md`, immediately after the existing "Every acceptance criterion must
be independently checkable by the reviewer" bullet:

```markdown
- **Every acceptance criterion must also be *agent-satisfiable*, not just
  checkable** (T-0300). See `docs/card-authoring-agent-satisfiability.md` for
  the full convention: the three-way rule every criterion must satisfy
  (agent has the capability / capability can reasonably be added / neither,
  so it becomes a `## Human verification (NOT an agent criterion — does not
  gate PASS)` step), and `tools/board/src/runner/impossibleAcceptancePreflight.js`,
  the mechanical warn-only backstop that flags likely-impossible phrasing
  before the implementer is spawned. It never blocks and never weakens the
  reviewer's fail-closed rule.
```

This is a pure addition (no existing line removed or reworded), scoped to exactly this card's own
decision, and requires no other change.
