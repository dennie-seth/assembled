# T-0286 attempt log: `.claude/**` instruction edits blocked in this session

**Card:** T-0286 — board direction-approval must propagate to `ASSET_PROVENANCE.md` (or be the
single source of truth).

## What happened

The chosen design is Option A (`docs/decision-log.md` DL-27): the board's own
`approved_by`/`approved_at` is the single source of truth for "is this approved?", exposed as
`approvalVerdict()` (`tools/board/src/lib/approvalGate.js`) and `GET /api/tasks/:id/approval`
(`tools/board/src/server/httpApi.js`). That part landed and is tested.

To actually close the class of bug (not just add an unused endpoint), a real consumer has to
resolve approval from that endpoint instead of `ASSET_PROVENANCE.md` prose. In this project the
two consumers that matter are agent *instructions*: `.claude/rules/assets.md` (loaded by the
`assets` agent before it decides whether to generate against a gated reference) and
`.claude/agents/assets.md` (the `assets` agent's own workflow). Both attempts to edit either file
in this session were refused by the harness itself, independent of the `infra` agent's own
documented scope (which explicitly includes `.claude/**`):

```
Edit(.claude/rules/assets.md)  -> "Claude requested permissions to edit
  .../.claude/rules/assets.md which is a sensitive file."
Write(.claude/rules/assets.md) -> same refusal, same wording
Edit(.claude/agents/assets.md) -> "Claude requested permissions to write to
  .../.claude/agents/assets.md, but you haven't granted it yet."
```

Three attempts against two different files, two different tools (`Edit` and `Write`), both
returning a refusal before any write occurred. This reads as a session-level guard on `.claude/**`
itself (protecting the harness's own agent configuration from being rewritten by a running agent),
not a per-file or per-content check — plausible and, if so, correct behavior for the harness to
have regardless of what this card's own in-repo agent definition claims about `infra`'s scope. It
is not something this session can talk its way around, and repeatedly retrying an already-refused
edit is exactly what `CLAUDE.md`'s own conduct expects an agent *not* to do.

## What shipped instead

Since the instruction-level fix is blocked, the mechanical fix that *is* fully within `tools/**`
and `.github/**` shipped in its place: `findApprovalDrift`
(`tools/board/src/lib/approvalProvenanceDrift.js`) plus the CI workflow
`.github/workflows/ci-approval-provenance-drift.yml`. It reads only the committed `tasks/*.md`
files and the committed `ASSET_PROVENANCE.md` text — no live board, no agent tool grant, nothing
that could be blocked the way the instruction edit was — and fails the PR if a provenance row's
own prose contradicts the card's real board verdict. This is a real, unconditional backstop: it
would have caught the T-0257/T-0243 drift on the very next push, rather than after days.

It is **not** a full substitute for the instruction-level fix. It catches a stale row already
committed to a diff under review; it does not stop the `assets` agent from reading
`ASSET_PROVENANCE.md`'s prose *before generating* and refusing (or proceeding) on the strength of
stale text the way the real T-0243 incident happened — that requires `.claude/rules/assets.md` to
actually say "resolve approval from the board, not from this file," which is exactly the edit that
was refused.

## The edit a human (or a session with `.claude/**` write access) should apply

Add to `.claude/rules/assets.md`, immediately after the existing `ASSET_PROVENANCE.md is
mandatory...` bullet:

```markdown
- **Approval verdicts come from the board, never from `ASSET_PROVENANCE.md`
  prose** (T-0286, `docs/decision-log.md` DL-27). Before generating against a
  reference/concept sheet gated by `requires_approval: true`, check
  `node tools/board/scripts/agentCurl.js GET "http://127.0.0.1:4173/api/tasks/<gating-card-id>/approval"`
  and its `approved` field — never infer approval, or its absence, from the
  provenance file's own text.
```

And to `.claude/agents/assets.md`, immediately after the existing `Every generated asset gets an
ASSET_PROVENANCE.md entry` bullet:

```markdown
- **Approval verdicts come from the board, never from `ASSET_PROVENANCE.md`
  prose** (T-0286, `docs/decision-log.md` DL-27). Before generating against a
  reference/concept sheet gated by `requires_approval: true`, check
  `node tools/board/scripts/agentCurl.js GET "http://127.0.0.1:4173/api/tasks/<gating-card-id>/approval"`
  and its `approved` field — never infer approval, or its absence, from the
  provenance file's own text.
```

Both are pure additions (no existing line removed or reworded), scoped to exactly the one decision
this card makes, and require no other change — `agentCurl.js` already permits a `GET` against the
board's own task API (`tools/board/src/lib/agentCurlPolicy.js`), so no grant change is needed for
the `assets` agent to run this command once the instruction exists.

`.claude/agents/reviewer.md` deliberately gets **no** matching edit: the mechanical drift check
that shipped is intentionally *not* wired into `verifyRouter.js`'s routed-verification list,
because doing so would inject a `Bash` command into the reviewer's required-verification section
that the reviewer's own `tools:` grant list does not include — turning every future PR that
touches `ASSET_PROVENANCE.md` into an automatic FAIL on a denied command, per `reviewer.md`'s own
(correct) fail-closed policy, rather than the drift check it was meant to be. The CI workflow is
the safe way to enforce it unconditionally; routing it through the reviewer agent should wait until
whoever has `.claude/**` write access can add the matching grant at the same time.
