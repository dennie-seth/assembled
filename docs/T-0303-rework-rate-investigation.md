# T-0303 investigation: rework rate 62% over 535 validations

**Card:** T-0303, auto-proposed by the flow-stats self-improvement loop
(baseline-done=198, proposed 2026-09-04T14:02:21.096Z).

## Why this note lives here, not in the card body

This board runs in db-mode (`BOARD_TASK_STORE=db`): there is no
`tasks/T-0303.md`, `tasks/T-0295.md`, or `tasks/T-0301.md` file to write
findings into, and `tasks/.runs/*.jsonl` (where a reviewer's verbatim FAIL
note text would otherwise be grep-able, per T-0216's and T-0301's own
investigation method) is untracked, per-checkout runtime state that does not
exist in this worktree. Same constraint T-0301's own audit
(`docs/T-0301-lost-escalations-audit.md`) hit and recorded. The evidence
below is therefore reconstructed from git history — commit messages on the
merged `feature/T-0295` and `feature/T-0301` branches, which record what
each reviewer VALIDATION round actually flagged and how it was fixed —
rather than quoted verbatim from a FAIL note payload this session cannot
read.

## Evidence cited by the card

- T-0295: 4 hits (2026-09-04T10:35 through T11:14, four review rounds ~13
  minutes apart)
- T-0301: 1 hit (2026-09-03T18:45)

## Root cause 1 — T-0301, already fixed: db-mode agent-name enum drift

`tasks.agent`'s SQLite CHECK constraint and `taskParser.js`'s
`ASSIGNABLE_AGENT_NAMES` are two independently-maintained lists. A `dispatch`
sentinel value was added to one and not the other, so every db-mode
escalation attempt silently failed the CHECK constraint and was swallowed by
an empty `.catch(() => {})` — no remediation card, no operator-visible
signal. T-0301's own commits (`85003c8` red test, `8b2db11` fix, `afc5922`
follow-up, `627921a` surfaced the swallowed log failure) fixed the immediate
bug **and** landed a systemic guard against recurrence:
`tools/board/test/agentCheckConstraintAgreement.test.js` reads the live
migrated schema's CHECK clause and asserts it's exactly
`ASSIGNABLE_AGENT_NAMES`, so the two lists can never diverge again without a
test failure. **No further action needed for this cause** — it already has
the "two lists must agree, checked mechanically" fix this kind of card is
meant to land, from a prior round.

## Root cause 2 — T-0295: an over-broad grant caught only by hand, at review time

T-0295 (Playwright browser-harness card) went through (at least) two
distinct reviewer-caught defects across its 4 evidence hits:

1. **Ambiguous wildcard grant** (commit `c50f13b`, verbatim from its own
   message): the recommended grant line `Bash(npm run test:browser:*)` is
   broader than intended. `isToolAllowed` (`tools/board/src/runner/
   toolAllowlist.js`) does raw string-prefix matching on the stripped
   wildcard, and npm's colon-namespaced script names mean the literal string
   `"npm run test:browser:install"` (a ~390MB `playwright install chromium`
   download) *also* starts with the stripped prefix `"npm run
   test:browser:"`. The wildcard silently authorised a script nobody meant
   to grant. Fixed by dropping the wildcard for an exact-match grant.
2. **A genuine CSS defect** (commit `216c337`): `body`'s `min-height:
   100vh/100dvh` doesn't bound the flex chain the column-scroll container
   depends on; only a real browser (not happy-dom) could catch this, and it
   was caught the first time the harness actually ran in one. This is a
   real implementation bug the review process is *supposed* to catch this
   way — not a systemic infra gap to close, so it's out of scope for this
   card's fix.

Cause 1 is the one that fits this card's suggested direction ("a recurring
guard, grant, or lint failure is the common pattern in this codebase") and,
unlike cause 2, is genuinely systemic: **any** future `Bash(npm run
X:*)` grant is vulnerable to the same ambiguity if another script shares `X`
as a literal colon-prefix, not just this one card's line. That line was
fixed by hand; nothing stopped the next one.

## Fix implemented

Added a generic guard, mirroring the "two independently-maintained lists
must agree" shape of T-0301's own fix:

- `tools/board/src/lib/npmGrantAmbiguity.js` —
  `findAmbiguousNpmRunGrants(allowedTools, npmScripts)` flags any
  `Bash(npm run <script>:*)` grant whose stripped prefix is also a literal
  prefix of a different `package.json` script name.
  `checkAgentGrantsForNpmAmbiguity(...)` runs it across every
  `.claude/agents/*.md`'s resolved `tools:` grant.
- `tools/board/scripts/checkGrantAmbiguity.js` + `npm run
  check:grant-ambiguity` — standalone CLI, same convention as
  `checkDeliverable.js` / `checkPlannerDiffGuard.js`.
- `tools/board/src/runner/verifyRouter.js` — `touchesBoard` now also fires
  on a diff that only touches `.claude/agents/*.md`. Without this, a future
  card that adds an ambiguous grant *without* also touching anything under
  `tools/board/**` (the exact T-0295 shape — the grant line lives in an
  agent file, not in `tools/board/`) would get no automated verification
  routed to it at all, since the board's own test suite is what carries this
  guard.
- Tests: `tools/board/test/npmGrantAmbiguity.test.js` (unit cases
  reproducing the exact T-0295 collision, plus a real-repo regression case
  against the live `.claude/agents/*.md` files and `tools/board/
  package.json`, which passes today since no current grant is ambiguous)
  and a new case in `tools/board/test/runner/verifyRouter.test.js` for the
  routing change.

## Why the flow-stats number won't move immediately

Same conclusion T-0216 reached for the same reason: the 62% rate is
cumulative over 535 validation notes since project start. This fix is
preventive — it stops a *future* ambiguous-grant defect from costing a
reviewer FAIL/fix round trip, the same way T-0295's already-fixed grant line
(`c50f13b`) did. It cannot retroactively un-spend the FAIL notes already in
the denominator, and no current agent grant trips the new guard, so there is
no live bug for it to immediately fix either. A visible drop in the
aggregate rate requires enough new validations to flow through for the
avoided-FAIL effect to outweigh the existing corpus — the same 50+
validation lag T-0216 estimated at 1-3 weeks of normal throughput.
