# T-0301 audit: escalations lost to the missing `dispatch` CHECK value

**Card:** T-0301 — `dispatch` missing from the db-mode `tasks.agent` CHECK constraint,
silently killing every db-mode escalation since the db-store cutover.

## What this records

Acceptance criterion 5 asks: *"Verify whether any earlier escalations were lost this way
and note the finding (read-only; do not retro-create cards)."* This file is that note. No
card was created or modified to record it, per the card's own instruction — the finding
lives here and in this file's git history only.

## Method and provenance

The board keeps one `.jsonl` run log per card run under `tasks/.runs/`. That directory is
untracked, per-checkout runtime state — `git check-ignore -v tasks/.runs` resolves it via
`/home/dennieseth/dev/assembled/.git/info/exclude:7:/tasks/`, and it is not shared between
worktrees. This session's worktree (`worktrees/T-0301`) has no `tasks/.runs/` directory at
all, so the grep behind this finding could not be re-run from here.

The finding was produced by the reviewer's own VALIDATION pass against this card on
2026-09-03, which does run from a checkout with live access to `tasks/.runs/`. Its verdict
text (recorded verbatim in this card's body) reports:

> grepping `tasks/.runs/*.jsonl` for `'Escalation failed: CHECK constraint failed: agent IN'`
> yields 11 genuine lost escalations across 8 distinct cards ... spanning
> 2026-08-29 through 2026-09-03, i.e. six days, not just "today's run logs" as the card's
> Evidence section assumed.

The reviewer also flagged the false-positive trap in the naive query: a bare
`Escalation failed` grep returns 39 hits, most of which are agent transcripts quoting the
source line (`` `Escalation failed: ${err.message}` ``) rather than an actual failure — the
query has to anchor on the CHECK-constraint text specifically.

## The finding

Between **2026-08-29 and 2026-09-03** (six days, not just the card's originally-cited
"today"), db-mode escalation failed silently 11 times across 8 distinct cards. Each of
these is a card that exhausted its retries, attempted to escalate, hit the missing-`dispatch`
CHECK constraint, and left no remediation card and no operator-visible signal — exactly the
failure mode this card's `_logEscalation`/`.catch(() => {})` fix (see `0004_add_dispatch_agent.sql`
and the `runOrchestrator.js` console.warn added in this branch) addresses going forward:

| Card | Run(s) lost |
|---|---|
| T-0243 | 2026-08-30, 2026-09-02 |
| T-0249 | 2026-08-29 |
| T-0258 | 2026-08-31 |
| T-0259 | 2026-08-31 12:19, 2026-08-31 13:10, 2026-08-31 16:27 |
| T-0267 | 2026-09-01 |
| T-0288 | 2026-09-03 (two runs) |
| T-0290 | 2026-09-03 |

That is 11 lost escalation attempts (2 + 1 + 1 + 3 + 1 + 2 + 1) across the 8 cards listed.

## What was not done, on purpose

Per the card's explicit "Do not" / acceptance wording, none of the above 8 cards were
retro-created, reopened, or had a remediation/dispatch card manufactured after the fact.
This is a read-only historical note, not a remediation action. If any of these cards still
need a human-driven follow-up, that is a decision for whoever triages this note next, not
something this card's fix should do automatically.
