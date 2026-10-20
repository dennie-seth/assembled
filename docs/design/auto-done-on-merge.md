# Auto-done on merge

**Status:** implemented. **Owning code:** `tools/board/src/runner/mergeReconciler.js`,
`tools/board/src/runner/githubOps.js` (`getPrState`), wired into
`tools/board/src/server/boardServer.js`. See [[agent-runner.md]] for the base card lifecycle
this extends, and `tools/board/src/runner/lifecycle.js` for the state machine `review` already
sits at the edge of.

## Problem

Reaching `done` has always been entirely manual: @DennieSeth merges the PR and then drags the
card himself. T-0434 sat in `review` with **#444 already merged and `f3fee0ee` already on
develop**, simply because the merge happened while he was mid-sequence and the board had just
restarted. Nothing was broken -- the board just had no way to notice. This module is what
notices.

## Relationship to T-0444

T-0444 tracks `reviewed_sha`/`verified_sha`/`current_sha` so a review indicator stops claiming a
head it never actually checked -- that is about verification freshness *within* a card's run.
This module is a **lifecycle transition driven by an external event** (a PR merging), with
different data (PR state, not SHAs) and a different failure mode (a missed event while the
process was dead). The two are cross-referenced, not merged: this module never reads or writes
`reviewed_sha`/`verified_sha`/`current_sha`, and T-0444 never writes `status`.

## Trigger: a linked PR observed in GitHub's `MERGED` state

A card's `pr` field (a full PR URL, set once by `RunOrchestrator._handlePass` in the same write
that moves the card to `review` -- see `runOrchestrator.js`) is read back via
`gh pr view <url> --json state,url,headRefName,number` (`githubOps.js`'s `getPrState`). GitHub's
own `state` enum is exactly `OPEN` | `CLOSED` | `MERGED`, and a PR closed without merging is
always reported `CLOSED`, **never** `MERGED`, regardless of whether it ever carried a merge
commit. Trusting this single field is deliberate: it is the one signal GitHub itself guarantees
is unambiguous, so there is no separate "does it have a merge commit" check layered on top --
that would be redundant with what `state` already encodes, and redundant checks are exactly where
a defect like "a closed-without-merge PR silently marks abandoned work complete" would hide.

Only `state === "MERGED"` qualifies. A draft PR, an open PR, a closed-without-merging PR, and a
PR whose branch was deleted without ever merging all report something other than `MERGED` and are
left completely untouched.

## Eligible source statuses

`MERGEABLE_STATUSES = {"review"}` -- the *only* status this module ever moves a card out of.
This is deliberately narrow, not an oversight:

- `_handlePass` is the only place a card's `pr` field is ever set, and it sets `pr` in the exact
  same write that moves the card to `review`. Under normal operation a PR cannot exist on a card
  before that card has already reached `review`.
- A human only ever merges a PR once they've looked at `review`.

So a `MERGED` PR on a card sitting in `backlog`/`ready`/`in-progress`/`validation`/`blocked` is
not a routine case this module silently completes -- it is a **symptom of something else being
wrong** (a stale link, a card re-run after its PR already merged, manual tampering) and is
logged loudly instead:

> `card T-0XXX is "in-progress" but its linked PR (...) is already MERGED -- only "review"
> auto-completes on a merge, so this is being reported, not auto-completed. A human should look
> at T-0XXX.`

`done` and `retired` are excluded from that reporting set on purpose: those are already terminal,
and a `MERGED` PR behind a `done` card is the ordinary case for literally every card that has ever
shipped -- it is not worth a word. A `done` or `retired` card is simply left alone, silently.

## The approval gate still applies

A `requires_approval: true` card (`docs/design/`'s own direction-approval gate,
`tools/board/src/lib/approvalGate.js`) is never moved to `done` by this module even if its PR
merged -- `needsApproval(task)` is checked before the write, exactly like the HTTP PATCH path's
`applyApprovalGateToPatch`. The human verdict on a direction card is the point of the card, not
something a merged PR substitutes for. An approved `requires_approval` card (one that already
carries `approved_by`/`approved_at`) completes normally.

## Shared or misattributed PR links

Several cards pointing at the same PR, or one card's `pr` field pointing at a PR that actually
belongs to a different card's branch, is resolved by checking the PR's own `headRefName` against
the card's own `branch` field (set in the same `_handlePass` write as `pr`). A mismatch is treated
exactly like an unreadable PR: left untouched, logged with the specific mismatch, never acted on
blindly. In the normal case every card's `branch` is unique (`feature/T-NNNN-slug`), so at most
one card can ever match a given PR's head branch.

## Two independent recovery paths

Both call the exact same per-card logic (`reconcileCard`) over every card currently in the store
-- there is no separate "startup mode" branch, because merge detection reads external GitHub
state plus the card's own fields, never this process's own in-memory run-tracking (contrast with
`orphanReaper.js`, which *does* need a startup/sweep split because its signal -- a recorded pid --
only means something once compared against the current process's liveness view). That absence of
special-casing is exactly why each path is independently sufficient: disabling one changes nothing
about what the other recovers.

- **`reconcileOnStartup`** -- runs once at boot, against every card in the store. This is what
  catches a merge that happened for however long the board was down, restarting, or not yet
  running this code at all -- the literal T-0434 case. Gated by `BOARD_MERGE_RECONCILE_STARTUP`
  (default on).
- **`sweepOnce`**, driven on an interval by `start`/`stop` -- the ongoing companion for a merge
  that happens while the board stays up continuously. Gated by `BOARD_MERGE_RECONCILE_SWEEP`
  (default on).

A master switch, `BOARD_MERGE_RECONCILE` (default on), gates both.

**Sweep interval:** `DEFAULT_MERGE_RECONCILE_INTERVAL_MS = 5 * 60_000` (5 minutes), overridable
via `BOARD_MERGE_RECONCILE_INTERVAL_MS`. Same order of magnitude as `autoPullPoller.js`'s
`DEFAULT_AUTOPULL_INTERVAL_MS`, and for the same reason: a card sitting in `review` a few minutes
longer than strictly necessary after a merge is not an incident, and polling GitHub every few
minutes per open-PR card is cheap. Nothing about this needs to be live -- a human merging a PR is
already a deliberate, infrequent act, not a hot path a few minutes of latency would hurt.

**Startup sweeps full history, deliberately.** `reconcileOnStartup` does not restrict itself to
cards created after this feature shipped -- it walks every card currently in the store. A
deploy-time cutoff was considered and rejected: the bug this module exists to fix (T-0434) *is* a
card stuck in `review` from an old, already-missed merge, so a cutoff would leave exactly that
case unfixed on the very first boot after deploying this. This is safe to do unbounded because of
`MERGEABLE_STATUSES`, not despite it: the only cards a sweep can ever touch are the ones still
sitting in `review` with a `pr` link, and the only thing it can ever do to one is move it to
`done` -- the status a human already reached by merging. It can never resurrect a `done`/`retired`
card, and it never revisits a card a second time once it leaves `review`.

**Boot never blocks on this.** `boardServer.js` calls `reconcileOnStartup()` fire-and-forget
(`.catch`-guarded, not `await`ed) before calling `start()`. A long outage can leave many `review`
cards to check, each a real network round-trip to GitHub; letting that block `server.listen` would
mean an outage in exactly the scenario this module exists for could also delay the board coming
back up. The periodic sweep is the ongoing backstop regardless of how long the first pass takes.

## Safety and idempotence

- **Status is checked before any network call, not after.** `reconcileCard` bails out on a status
  outside `ELIGIBLE_FOR_PR_READ_STATUSES` (`MERGEABLE_STATUSES` union `REPORT_ONLY_STATUSES`)
  before ever calling `gh pr view`. This matters at scale: every `done` card that has ever shipped
  still carries its old `pr` URL, so without this check every sweep -- forever -- re-reads GitHub
  for the entire done/retired backlog only to discard the result once the status check finally
  runs. That is real "hammering the API", not a hypothetical: a sampled 458-card deck had 19
  already-`done` cards with a live `pr` field. `reconcileAll` filters the eligible set once, up
  front, against this same set, so the done/retired backlog is never even handed to a PR read.
- **Bounded GitHub reads.** Every `gh pr view` call is wrapped in `boundedAwait.js`'s
  `withTimeout` (default 8s, `prReadTimeoutMs`). A hang, a rate limit, or any other slow response
  resolves to "unreadable" rather than wedging the sweep tick or stalling boot -- the same posture
  `launchAdvisory.js` already established for the launch path.
- **Bounded concurrency, not sequential or unbounded.** `reconcileAll` reads at most
  `DEFAULT_RECONCILE_CONCURRENCY` (4) cards' PR state at once, via a small internal
  `mapWithConcurrency` helper. Fully sequential would mean N eligible cards x `prReadTimeoutMs`
  each during an outage -- with even a modest `review` backlog that can run long enough to overrun
  the sweep interval or stall boot. Fully parallel (`Promise.all` over the whole eligible set)
  would fire N simultaneous `gh` subprocesses at a possibly rate-limited API -- the literal
  "hammering" AC #15 warns against. 4 is small enough to never look like a burst, and the eligible
  set is small by construction (only `review` plus the report-only statuses), so this bound exists
  for the batch/outage tail, not the common case.
- **An in-flight guard prevents overlapping passes.** `reconcileOnStartup` and `sweepOnce` both
  go through a shared `reconcileAllGuarded` wrapper: if a pass is still running (GitHub degraded,
  a large eligible batch) when the next sweep tick fires, the new tick logs that it is skipping
  rather than starting a second, overlapping pass against the same cards. Without this, a tick
  that outlives its own interval would pile up concurrent `gh` subprocesses instead of simply
  running a little late -- exactly the "stall a tick / wedge the poller" failure AC #14 forbids.
- **Per-card error isolation.** A thrown error reconciling one card (a store write failure, an
  unexpected exception) is caught, logged via `logger.error`, and the sweep continues with the
  next card -- one bad card never aborts the rest of the batch.
- **Idempotent by construction.** The write uses `store.update(id, patch, { expected: { status:
  "review" } })`. Reconciling the same card twice is a no-op the second time: once `status` is
  `done`, `MERGEABLE_STATUSES` no longer matches and nothing is written. A card already `done`
  stays `done`; a card a human moved to `retired` after its PR merged stays `retired` -- this
  module only ever moves a card towards `done` once, from `review`, and never second-guesses
  anything past that.
- **No conflicting write with a human racing the sweep.** The same `expected: { status: "review"
  }` precondition means a human dragging the card to `done` (or anywhere else) at the same moment
  wins the race cleanly: the loser gets a `StaleWriteError`, which is caught, logged ("changed
  status before the done write landed ... skipped, no conflicting write"), and treated as a no-op
  rather than retried or escalated.
- **No linked PR, or a PR that cannot be read** (API failure, deleted/renamed PR, auth problem):
  the card is left exactly as it is and a reason is logged. This module never guesses a state it
  could not actually observe.

## Explicitly out of scope

- **A PR merged and later reverted on develop.** The card stays `done`. Reverting a merge is its
  own decision with its own consequences (what else landed on top of it, whether a clean revert
  is even possible) -- it is a new card, not an undo of this transition. This module has no
  concept of "un-merge" and does not try to invent one.
- **Review-state SHA tracking.** That is T-0444's job (`reviewed_sha`/`verified_sha`/
  `current_sha`); this module does not read or write any of those fields.
- **Anything on a PR being closed without merging.** Covered above -- `state !== "MERGED"` is
  simply not acted on, full stop.
- **Changing what `done` itself triggers.** This module writes `status: "done"` through the same
  `store.update` every other write path uses, so it picks up whatever `done` already does
  (commit-on-write, the board's own broadcast) without re-implementing or special-casing any of
  it. It does not add any NEW done-triggered behaviour of its own.
