# Board QoL 2026-10 — delivery plan

**Status:** index only. **Owning epic:** T-0443. **No behaviour change** lands on this card —
every item below is implemented by its own child card. Card IDs below are references into the
board's own task store, not files in this repo — look them up by ID in the board UI/API.

## Source

Chat ran a read-only board logic audit on 2026-10-09 against source revision
`692edb992f375d8db351ae9763472605762a8b45`. The report and its supporting snapshots
(`tasks.json`, `poller.json`, `health.json`, `recent_verdicts.json`) are a committed artefact
on the authoring host, at:

```
F:\PetProjects\assembled\board_audit_2026-10-09\REPORT.md
```

@DennieSeth agreed with all nine numbered items. This document does not restate the report —
it is the index that tells a reader which child card carries each item, and why the three
delivery slices are ordered the way they are. **The report is not copied into the repo** — it
is a committed artefact at the path above, on the authoring host (not reachable from this
repository's worktrees); don't restate its contents wholesale here. Each child card's own
acceptance criteria are the specification for that card's scope (see "Doc drift" below).

## Why three slices, in this order

The audit's own argument, not an arbitrary grouping: **later items depend on earlier ones
being trustworthy.**

1. **Slice 1 — make review state trustworthy.** Before anything resumes, reuses, or trusts a
   prior result, the board's own record of "what was reviewed" and "what failed" has to be
   correct: the recorded reviewed/verified/current SHAs, a lint step that can't mutate what it
   just tested, a receipts mechanism that doesn't depend on an agent phrasing a shell command
   the way the harness expects, and a failure signature keyed on content rather than on HEAD or
   porcelain status. Every later slice reads these records; if they're wrong, the later slices
   amplify the error instead of fixing it.
2. **Slice 2 — avoid repeated work.** Once review state is trustworthy, it's safe to let a run
   resume at a failed phase instead of repeating implementation and review, freeze the
   acceptance contract a run is judged against instead of re-litigating it every round, reuse
   prepared environments within a run, and narrow the validation route for a ledger-only
   change. None of this is safe to build on an untrustworthy signature or an ambiguous
   review-state record — hence slice 1 first.
3. **Slice 3 — reduce waiting.** With trustworthy state and less repeated work in place, the
   remaining items shorten the time a human or a dependent card spends waiting: event-driven
   scheduler wake-up, outcome-aware dependencies (so a dependent isn't blocked by the wrong
   notion of "done"), rolling flow metrics that don't let one card's history dominate the
   diagnosis, and a console-rendering cleanup the audit itself ranks last.

## Audit items → child cards

All nine numbered items from the report appear below. Several were split across two child
cards because the audit's own item bundled a correctness bug with a larger mechanism, or a
small independently-testable fix with its larger counterpart — each split is called out with
why.

| # | Audit item | Child card(s) | Slice |
|---|---|---|---|
| §1 | Finalization ordering and SHA tracking (evidence/ledger promotion and develop-sync happen after PASS is recorded; a failed sync can read as a successful one) | T-0444 | 1 |
| §2 | Reviewer verification: a mutating lint step inside the verification route, and the larger harness-owned receipts mechanism | **Split.** T-0445 — the correctness bug (`ruff check --fix` in the reviewer route), independently fixable. T-0446 — the receipts mechanism itself (the larger item this was bundled with in the report) | 1 |
| §3 | Failure-repetition detection: the failure signature's content-identity gaps, and the larger typed-failure-class/resume mechanism | **Split.** T-0447 — the failure-signature fingerprint fix, small and independently testable. T-0448 — typed failure classes and safe resume at the failed phase (the main item) | 1 (T-0447), 2 (T-0448) |
| §4 | Acceptance-contract freezing, and the review inbox / waiting-reason surface | **Split.** T-0449 — freeze a versioned acceptance contract per run. T-0450 — review inbox and actionable waiting reasons from a shared, side-effect-free evaluation | 2 |
| §5 | Auto-launch is globally serial on a 30-minute timer; event-driven wake-up on run completion | T-0454 | 3 |
| §6 | Dependency satisfaction can't express an experimental outcome (T-0431 → T-0359 is the live pilot edge) | T-0453 | 3 |
| §7 | Repeated environment preparation within a run, and a possible narrow ledger-only validation route | **Split.** T-0451 — reuse prepared environments within a run. T-0452 — document the approval-ledger invariants first, then evaluate (not assume) a narrow route | 2 |
| §8 | Flow statistics use lifetime counts, so a since-fixed card keeps influencing the diagnosis | T-0455 | 3 |
| §9 | Console log accumulation / detail-panel render scope — a code-level opportunity, not a measured slowdown; the report ranks it last of nine | T-0456 | 3 |

Thirteen child cards carry the nine items. §2, §3, §4 and §7 split cleanly into a smaller,
independently-testable fix and the larger mechanism it was bundled with in the report; none of
the other five items needed splitting.

## The audit's non-goals, carried over

Dropping any of these invites exactly the misreading the report warns about:

- **The verdict sample is not a general failure rate.** The report's own sample — T-0430
  through T-0442, 13 FAIL / 9 PASS, with ten of those thirteen FAILs from T-0436 alone — is a
  point-in-time snapshot of five cards, deliberately recent and deliberately non-random. It is
  not a defensible general failure rate, and it motivates *why* the audit happened, not a
  lifetime quality metric for the board. If this document (or any child card) quotes the 13/9
  split, the non-random caveat belongs in the same sentence.
- **Concurrency is not the fix, and raising it is out of scope.** The response to a serial
  auto-launch poller and a 30-minute average scheduling wait is event-driven wake-up (T-0454),
  not more concurrent runs. T-0454's own scope note is explicit: increasing concurrency is
  "explicitly not this card," and no rule may be bypassed to get there. Concurrency stays
  deferred until measurement — not this audit — shows serial execution is actually the
  dominant bottleneck.
- **The response to the FAIL concentration is to inspect the workflow it came from, not to tune
  the board to a lifetime percentage.** Ten of thirteen FAILs came from one card, T-0436. The
  correct reaction is to inspect what T-0436 was doing (an acceptance contract that moved
  mid-run — see T-0449's context), not to adjust review strictness, retry limits, or pass
  thresholds to make a lifetime number look better.

## Doc drift and scope boundaries

- **This document is an index, not a specification.** Each child card's own body is the
  source of truth for its own scope, acceptance criteria, and edge cases. As cards land,
  split further, or get re-scoped, this table may lag — that's expected. Trust the child
  card over this index if they ever disagree.
- **No child card depends on this one, and it must never gate one.** Every child card listed
  above has `depends_on: []`. This epic records the plan; it must never block a child's launch.
- **The report itself is not copied into the repo.** It's a committed artefact at the path
  above, on the authoring host (not reachable from this repository's worktrees). Link to it by
  path and source revision; don't restate its contents wholesale here.
