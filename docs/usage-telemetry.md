# Usage telemetry: verified source, per-window semantics, and staleness

**T-0367 (Ticket 1 / "T-A" of the WIP-gate set).** Evidence-only: this document and the
readers/ledger it describes change no launch, admission, or poller behaviour. They exist so
later cards (T-C cost estimator, T-D launch-boundary reservation) have a real, classified signal
to consume instead of the policy stand-ins `usageWindow.js` has used since T-0248/T-0295.

## Provenance of the claims below

`tasks/.runs/` is a runtime-only directory (see `.gitignore` / `runOrchestrator.js`'s `runsDir`
default) that starts empty in a fresh git worktree — but it is not empty at the repo root: 461
real `*.jsonl` run logs live at `/home/dennieseth/dev/assembled-board/tasks/.runs/`, reachable
from this worktree by absolute path with Read/Grep alone. Every claim below was checked directly
against those logs in this session, not taken as given from the task card:

- `five_hour`, status-only `allowed` event carrying **no** `utilization` field at all —
  `tasks/.runs/T-0287-2026-09-03T06-10-00-599Z.jsonl:1`. This is the direct evidence for the
  estimated-not-measured rule below: a status-only `allowed` reading can carry zero information
  beyond the coarse enum, so treating its policy-floor `0` as `measured` would be reporting a
  guess as a fact.
- `seven_day`, `allowed_warning` with numeric `utilization`/`surpassedThreshold` —
  `tasks/.runs/T-0221-2026-08-23T12-26-17-498Z.jsonl:724`:
  `{"status":"allowed_warning","resetsAt":1787781600,"rateLimitType":"seven_day","utilization":0.75,"isUsingOverage":false,"surpassedThreshold":0.75}`.
- The newest-event-is-sometimes-the-weekly-one failure mode this card exists to fix —
  `tasks/.runs/T-0367-2026-09-11T22-06-33-812Z.jsonl:1`, this card's own prior run log, opens with
  a `seven_day` event, not `five_hour`.
- The genuine 429 session-limit stop, with a full cumulative-usage object on the same event —
  `tasks/.runs/T-0366-2026-09-11T18-15-10-554Z.jsonl:237`: `terminal_reason:"api_error"`,
  `api_error_status:429`, `result:"You've hit your session limit · resets 9:50pm
  (Europe/Budapest)"`, plus `usage:{...}` and `total_cost_usd:1.0869613999999999` on that *same*
  `result` event. Worth stating explicitly for §3b below: a quota-stop still carries a real
  cumulative total, so the ledger's result-authoritative path records that total, not zero, for
  this outcome.
- No `rate_limit_event` carries its own wall-clock field — confirmed on the same log's very first
  line, `tasks/.runs/T-0366-2026-09-11T18-15-10-554Z.jsonl:1`, which has only `rate_limit_info`,
  `uuid`, and `session_id` — no `timestamp` key — unlike the `assistant`/`user` events around it,
  which all carry one. **Fix round (Codex review 2026-09-12, P1):** this file's original reader
  fell back to the *containing log file's* mtime as a stand-in for the event's observation
  instant — reproduced as a live bug: a `seven_day` reading in a log last modified 3 hours ago
  correctly read `stale`, but after appending one wholly unrelated `assistant` event to that same
  log (bumping the file's mtime to "now"), the identical stale reading flipped to `measured`. Any
  later write to the log — the *other* window's own telemetry, or ordinary turn output — could
  make an old reading look fresh. `runOrchestrator.js`'s `_runPhase` now stamps a `receivedAtMs`
  field (the board's own local clock reading, `this.now().getTime()`) onto every
  `rate_limit_event` at the instant its NDJSON parser hands the event back — before it is ever
  appended to the run log — and the reader below trusts that field, never the file's mtime.

If a future run's log ever fails to match one of these shapes, the reader below is still built to
fail safe: an unrecognized `rateLimitType` or `status` value is classified `unavailable`, never
guessed at, and never silently treated as `unlimited`.

## The real telemetry source

The `claude` CLI has no `usage`/`limits`/`status`/`quota` subcommand (`claude auth status --json`
returns only auth metadata) — reconfirmed here, unchanged from `usageWindow.js`'s note. The only
usage signal the CLI publishes is the `rate_limit_event` NDJSON event it emits into
`tasks/.runs/*.jsonl` roughly once per assistant turn:

```json
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed" | "allowed_warning" | "rejected",
  "rateLimitType":"five_hour" | "seven_day",
  "resetsAt": <unix seconds>,
  "utilization": <0..1, present on at least allowed_warning events>,
  "surpassedThreshold": <0..1, present alongside utilization>,
  "overageStatus": "...", "overageDisabledReason": "...", "isUsingOverage": <bool>
}}
```

A terminal quota stop instead ends the run's final `result` event with:

```json
{"type":"result","is_error":true,"terminal_reason":"api_error","api_error_status":429,
 "result":"You've hit your session limit · resets <time>"}
```

### Per-window record (5-hour and weekly), independently

| | `five_hour` | `seven_day` |
|---|---|---|
| Limit-pool identity | Per-account, per-provider (Anthropic API via the `claude` CLI's own auth), not per-model — `rate_limit_info` carries no model field, and neither window type is scoped narrower than the authenticated identity `claude auth status` reports. | Same identity, longer pool. |
| Units | Utilization, 0..1 fraction of the window's cap. Not a token count or dollar figure — the CLI does not publish the underlying cap or a raw usage number, only this normalized fraction (when present) or the coarse `status` enum (always present). | Same unit, same caveat. |
| Observation timestamp | No event carries its own wall-clock field, so the board stamps one itself: `runOrchestrator.js`'s `_runPhase` sets `receivedAtMs` (`this.now().getTime()`) on every `rate_limit_event` the instant its NDJSON parser hands the event back, before it's ever appended to the run log. `readWindowUsage` selects the newest MATCHING event by this field, never by the containing log file's mtime (fix round, Codex review 2026-09-12, P1 — see the reproduced bug in the "Provenance" section above). A record with no `receivedAtMs` at all — one written before this fix landed, or by anything that appends to a run log directly rather than through the orchestrator — has no trustworthy timing and is always classified `stale` regardless of file mtime, never silently trusted as fresh; see "Classification" below. | Same mechanism. Weekly events are much sparser (once per ~week's worth of runs vs. once per turn), so a `seven_day` reading is more likely to sit in a log that keeps growing long after that specific reading arrived — exactly the case a file-mtime-based reader gets wrong most often. |
| Reset semantics | `resetsAt` (unix seconds) is the instant this specific window's cap frees up. Verified (not inferred from the phrase "5-hour window"): `usageWindow.js`'s `utilizationFromRateLimitInfo` already treats `now >= resetsAt*1000` as an elapsed window reading as fresh, and that behavior is unchanged here. Each window's `resetsAt` is read from its *own* matching event only — a `five_hour` reading never inherits or is reset by a `seven_day` event's `resetsAt` or vice versa (see "read independently" below). | Same semantics, own `resetsAt`. |
| Maximum acceptable staleness | 15 minutes (`DEFAULT_MAX_STALENESS_MS.five_hour`) — measured, not asserted: `tasks/.runs/T-0366-2026-09-11T18-15-10-554Z.jsonl` records seven consecutive `five_hour` readings in one continuous session at lines 1/21/61/158/164/200/235. Using the nearest neighbouring `assistant`/`user` event's own `timestamp` field as each reading's observation instant (lines 5/22/62/159/165/199/234 respectively), the gaps between consecutive readings run ~9s, ~33s, ~1m42s, ~4s, ~2m20s, ~1m58s — the worst observed gap is ~2m20s. 15 minutes is >6x that worst observed gap, not a placeholder. | 2 hours (`DEFAULT_MAX_STALENESS_MS.seven_day`) — also measured, corrected from an earlier reviewer round that (correctly) flagged this file as having grown since first cited: `tasks/.runs/T-0367-2026-09-11T23-06-33-652Z.jsonl` accumulates `seven_day` readings across every implementer/reviewer session run against this same card, at lines 1/287/411/619/1029/1190/1434. Only lines 1 and 287 share one session (`c3cf5aa3-...`, the only true same-session repeat in the file) — ~5m8s apart (23:06:41 → 23:11:49, using the neighbouring `assistant` timestamp at line 6 as the session-start anchor and the tool-result timestamp at line 288 for the second reading). The rest (lines 411/619/1029/1190/1434) are each a *different* session's own opening reading, not a repeat, so they don't tighten the within-session bound; they do confirm the window's utilization holds steady (0.59–0.61) across many separate orchestrator runs, never misread as reset. Cross-session, the gap between a card's separate runs widens to roughly an hour (`tasks/.runs/T-0367-2026-09-11T22-06-33-812Z.jsonl`, created exactly one hour before the 23:06 file, also opens with its own `seven_day` reading at line 1). 2 hours sits above every observed gap, same-session or cross-session. Both constants are exported and overridable per call; tightening them is a config change, not a code change. |

### Reading independently, not "newest wins"

The existing `readNewestRateLimitInfo` (unchanged by this card, still used by the live poller)
takes the single newest `rate_limit_event` in the newest log, regardless of which `rateLimitType`
it names. The task evidence is explicit that the newest event is sometimes the weekly one — so a
consumer reading "newest event" as "current 5-hour pressure" is silently looking at the wrong
window, and a `five_hour:allowed` fact can never surface at all if the newest recorded event
happens to be `seven_day`.

`usageTelemetry.js`'s `readWindowUsage` fixes this by scanning for the newest event **matching a
specific `rateLimitType`**, once per window, so a `seven_day:rejected` event two logs back is
still found even when the very latest event anywhere is `five_hour:allowed`. See
`usageTelemetry.test.js`'s "independent windows" suite for the failure mode this prevents and the
regression test that pins it.

"Newest" is decided by each matching candidate's own `receivedAtMs` (see "Observation timestamp"
above), never by which log file happens to have the newest mtime: `findNewestMatchingRateLimitInfo`
still shortlists up to `maxLogsScanned` logs by mtime (a cheap heuristic for which files are worth
opening at all), but then compares every matching candidate found across that shortlist by receive
timestamp before picking a winner. A fix-round regression test (Codex review 2026-09-12, P1) pins
this directly: two logs each carry a matching event, the log with the OLDER mtime holds the event
with the NEWER `receivedAtMs`, and the reader still picks that one.

## Classification: measured / estimated / stale / unavailable

Every reading `readWindowUsage`/`readUsageTelemetry` returns is one of exactly four
classifications, so a caller can never mistake a policy stand-in for a real number, or a merely-old
reading for a genuinely-missing one:

- **`measured`** — the event carried an explicit, in-range (`0..1`) numeric `utilization`, the
  reading has a trustworthy `receivedAtMs`, and it is fresh (age ≤ the window's max staleness).
  This is real telemetry, not a guess.
- **`estimated`** — no numeric `utilization` was present, so the reading falls back to the same
  status-only stand-in `usageWindow.js` already uses (`allowed`→0, `allowed_warning`→0.9,
  `rejected`→1, elapsed-reset→0). Still requires trustworthy, fresh timing. **A status-only
  `allowed` event is always `estimated`, never `measured`** — the zero it reports is a policy
  floor, not a measurement of zero usage, and collapsing that distinction was exactly the bug this
  card exists to fix.
- **`stale`** — either a matching event was found but its observation age (by `receivedAtMs`)
  exceeds the window's max staleness, OR the event has no trustworthy `receivedAtMs` at all (a
  historical record predating this fix, or anything that wrote a raw event outside the
  orchestrator's own capture path) — an untimed record can never be proven fresh, so it is always
  treated as stale rather than trusting the file's mtime as a substitute (fix round, Codex review
  2026-09-12, P1). The numeric `utilization` is deliberately **not** surfaced as usable in either
  case (`utilization: null`) — "unknown or stale capacity must never silently become unlimited"
  means a stale (or untimed) `allowed` must not read the same as a fresh one to any downstream
  gate. `timingTrusted: false` on the reading distinguishes the untimed case from a genuinely aged
  one, and `observedAtMs`/`ageMs` are both `null` when timing isn't trustworthy.
- **`unavailable`** — no event matching this window's `rateLimitType` was found anywhere in the
  scanned logs, or its `status` was unrecognized (a CLI value this reader has never seen). Also
  `utilization: null`. Distinguished from `stale` in the reading's `reason` string and in which of
  `logPath`/`observedAtMs` are present (both `null` for `unavailable`, `logPath` populated for
  `stale` even when `observedAtMs` is `null` for an untimed record).

An elapsed reset (`resetsAt` already in the past relative to `now`) invalidates the OLD window's
observation rather than reporting verified empty capacity: it still reads `estimated` (never
`measured`) at `utilization: 0`, since a reset having occurred is not proof the new window is
actually empty — another consumer may already have spent some of it before this reading was taken.
`resetElapsed: true` on the reading is what distinguishes this from a genuinely fresh zero.

## The idempotent usage ledger

`runLog.js` retains every event verbatim in `tasks/.runs/*.jsonl` already — the ledger does not
duplicate that; it stores a **derived summary**, logically one entry per
`(card, execution, invocation, attempt, phase, retry)` key, identified by a canonical path
(`usageLedgerEntryPath`: `tasks/.runs/<cardId>-exec<executionId>-inv<invocationId>-attempt<N>-<phase>-retry<N>.usage.json`,
mirroring `runState.js`'s `<taskId>.runstate.json` sidecar convention), always computed fresh from
the full event list rather than accumulated as deltas. The PHYSICAL file a given call publishes to
is that canonical path plus a `.rev<sequence>.json` suffix (see "Publication is monotonic per key"
below) — `readAttemptUsage`/`listCardUsageEntries` always resolve a key to its single
highest-revision entry, so every consumer of this module still sees exactly one logical entry per
key regardless of that physical layout. Recomputing from scratch on every call is what makes
recording idempotent by construction: calling `recordAttemptUsage` twice with the same events
converges on one reported entry with the same content, never doubling a running total. Recording
again with a **longer** events array (the normal "incrementally, and again at termination" case)
simply recomputes and publishes a fresh, higher revision with the fuller picture — still one
reported number per key. `usageLedgerEntryPath` rejects a missing/empty `executionId` (fix round,
Codex review 2, 2026-09-12, finding 4) or `invocationId` (fix round, Codex review 3, 2026-09-12)
before building any path string — no entry is ever written under an `…execundefined…`/`…execnull…`
key, or a shared default invocation key.

**Execution identity (fix round, Codex review 2026-09-12, P1).** The key used to be only
`(card, attempt, phase, retry)`, and every fresh `runCard()` invocation restarts its own attempt
loop at 1 — so a rerun of a card silently overwrote a previous launch's attempt-1 ledger files.
Reproduced live: a 100-token launch that ended in a quota-stop, followed by a fresh 25-token launch
that succeeded, both attempt 1 — the card's reported total came out to 25, not 125.
`usageLedger.js`'s `ensureExecutionId` mints a unique id (persisted to
`tasks/.runs/<cardId>.execution.json`) the moment `runCard()` claims a card, before ANY process is
spawned (worktree setup, planner, implementer, reviewer, merge-conflict all follow), and
`clearExecutionId` removes it again once that `runCard()` span ends normally — so the NEXT launch
mints a fresh id, while a launch whose own cleanup never got to run (the board process died
mid-run) leaves its id in place for `ensureExecutionId` to recover on the next call for that card.
Every ledger entry a run produces carries this same id. `executionTotal(entries, executionId)`
reports one launch's own total; `cardCycleTotal(entries)` now explicitly means the card's LIFETIME
total across every launch, not just the most recent one.

**Invocation identity (fix round, Codex review 2, 2026-09-12, finding 2).** Reusing the persisted
execution id on recovery is correct — the interrupted work is still logically the same launch — but
it is NOT the same thing as reusing that launch's ledger *entries*. After a board crash, a restarted
`runCard()` call resets its own attempt counter and opens a fresh run log; without a further
identifier, the restarted implementer phase's own `(executionId, attempt=1, phase=implementer,
retry=0)` key was identical to the interrupted phase's, so its terminal record silently overwrote
the interrupted one. Reproduced with real ledger persistence: a 100-token interrupted attempt,
followed (same execution id, no cleanup in between) by a 25-token restarted attempt — the file kept
only `25`, losing the `100`. `_runPhase` now mints a fresh `invocationId` (`generateInvocationIdFn`,
default `randomUUID`) the instant it starts — one per NEWLY SPAWNED PROCESS, never reused across a
restart — and every `_recordUsage` call that phase's run produces (its own incremental records, and
the terminal record its caller makes once the fuller classification is known) carries that same id.
An execution id surviving into the next `runCard()` call is evidence of interrupted work to recover
*alongside*, not evidence that the next phase's own consumption should be folded into it: only a
genuine replay of the *same* original events (the growing-events-list case within one still-running
process, unchanged from before) targets the same key. See
`runOrchestrator.usageLedger.test.js`'s crash-recovery describe block for the end-to-end regression
(real `recordAttemptUsage`/`ensureExecutionId`, not mocked): both the interrupted and the restarted
entries survive under the same execution id but distinct invocation ids, and `executionTotal` sums
to the correct `125`.

**Never add per-message usage to a cumulative final result.** Each `assistant` event's
`message.usage` reflects that one API call. The final `result` event's `usage`/`total_cost_usd` is
already the *cumulative* total for the whole attempt. `summarizeUsageFromEvents` treats these as
mutually exclusive, not additive: when a `result` event carries a **valid** cumulative usage object,
its numbers are authoritative and the per-message sum is discarded entirely; only when no `result`
event exists at all (a crash, cancel, or phase-timeout truncation) does the per-message sum become
the recorded figure — explicitly tagged `usageSource: "incremental"` rather than `"result"`, so a
reader can tell a real completed total from a lower-bound estimate of an interrupted one at a glance.

**A `result` event is authoritative only with a valid usage object (fix round, Codex review 2,
2026-09-12, finding 3).** A `result` event with no `usage` field, an empty `usage: {}`, or a counter
that isn't a finite nonnegative number used to be coerced straight to an all-zero token summary and
reported `usageSource: "result"`, `usageIncomplete: false` — a *measured, complete* zero-cost
session, discarding whatever real incremental usage had already been seen. Reproduced: a genuine
100-input-token message followed by a bare `{type: "result"}` reported `0` input tokens, not `100`.
`summarizeUsageFromEvents` now validates every usage counter (`input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`) as finite and nonnegative before trusting
a `result` event at all; a missing/empty/malformed usage object falls back to the known incremental
sum and sets `usageIncomplete: true`, same as a truncated run with no `result` event at all. The
same finite/nonnegative validation applies to `assistant`-event usage — a malformed per-message
counter is treated exactly like a missing one (incomplete, never coerced to zero), not just an empty
object.

A missing `total_cost_usd` is reported as `costUsd: null` ("unknown"), never `0` — a real measured
zero cost (`total_cost_usd: 0` on a valid result) stays distinguishable from "we never got a cost
figure at all". `costUsd` is only ever a genuine `0` when `usageSource` is `"none"` (literally no
events were ever seen) or when a valid `result` event explicitly reported zero.

**Message-level dedup (fix round, Codex review 2026-09-12, P1).** The incremental path used to sum
every `assistant` event's usage unconditionally, on the assumption each represents a distinct API
call. A live-log audit (six recent runs, all six affected) found the CLI instead repeats the same
assistant message id multiple times, each occurrence carrying the SAME usage snapshot, not a
delta — one card's own log had 234 of 284 distinct message ids repeated, 323 extra events.
Reproduced: two events sharing one message id, each reporting `input: 10`, summed to `input: 20`
instead of `10`. `summarizeUsageFromEvents` now keys incremental usage by `(session_id,
message.id)` and keeps the LAST snapshot seen per key rather than summing repeats. An event with no
usable identity (missing message id, or missing/malformed usage) is never folded in as zero cost;
it instead sets `usageIncomplete: true` on the summary and the recorded ledger entry, so a reader
can tell "measured, low" from "some of this attempt's usage could not be read at all". A final
`result` event, when present, is still fully authoritative over all of this within its session.

Outcome and completeness are supplied by the caller (the orchestrator knows *why* an attempt
stopped feeding events — success, quota-stop, reviewer FAIL, cancel, crash, or phase timeout; the
ledger does not re-derive that from raw events). `complete: false` on cancel/crash/timeout is what
marks a recorded figure a lower bound rather than a finished attempt's cost.

Attempt totals sum every phase/retry recorded for one `(card, attempt)` pair; card-cycle (lifetime)
totals sum every execution/attempt recorded for a card; execution totals sum one launch alone. All
three are computed on read (`attemptTotal`/`executionTotal`/`cardCycleTotal` over
`listCardUsageEntries`), not stored redundantly, so there is nothing to keep in sync.

**Write ordering and atomicity (fix round, Codex review 2026-09-12, P2).** Every write used to go
straight to the real sidecar path with no ordering guarantee and no atomicity. Reproduced: an
earlier in-progress write, artificially delayed, unblocked AFTER a later terminal write had already
landed — the delayed write clobbered it, leaving the file showing the stale in-progress figure
instead of the real terminal result. `recordAttemptUsage` writes to a temp file then publishes via
atomic rename, so a concurrent reader of the real path always sees either the complete previous
entry or the complete new one, never a partial write.

**Publication is monotonic per key by construction, via immutable revision files (fix round, Codex
review 3, 2026-09-12, finding 1 — superseding the prior `bestKnownByKey`/`diskSequenceByKey`
self-heal design below).** Two earlier attempts both wrote every racing write for a key to the SAME
mutable path and tried to reconcile after the fact:

1. A synchronous "last committed sequence" check right before rename — but it marked a sequence
   committed *before* its rename actually completed, so an older write could pass the check, stall
   mid-rename, and land on disk *after* a newer write's rename had already published. Reproduced:
   delay the older write's `renameFn`, let a newer terminal write publish first, then release the
   older one — the final file regressed to the older write's stale figures.
2. A "self-heal" follow-up (`bestKnownByKey` tracking the freshest entry INTENDED for a key,
   `diskSequenceByKey` tracking what was actually last rendered to disk) that republished the
   freshest entry whenever a write noticed its own rename had left disk stale. This fixed the
   ordinary case but the repair step could itself fail (an injected `EIO` on the repair rename) and
   nothing else was left to retry it — the corrupted, stale value stayed visible indefinitely, and
   even when repair succeeded, there was a real window where a concurrent reader could observe the
   stale value before the repair rename landed.

Both approaches shared the same flaw: they let TWO writes' renames target the same destination path
and tried to out-race or repair the result afterward. `recordAttemptUsage` now sidesteps the race
instead of reconciling it: each call publishes to its OWN immutable revision file —
`<canonicalPath>.rev<sequence>.json`, where `sequence` is a monotonic counter assigned synchronously
in call order at function entry and embedded in the entry as `revision` — via the same
write-temp-then-atomic-rename as before, but never onto a path any other write could also be
targeting. `readAttemptUsage`/`listCardUsageEntries` scan for every revision file published under a
key's canonical path and report the one with the highest `revision`. An older write's rename,
however late it lands — or even if it fails outright — can therefore never overwrite, corrupt, or
transiently mask a newer revision's content, because there is no shared destination for it to land
on: the value a reader can observe for a key only ever advances as higher revisions publish, never
regresses, at every point a reader might sample it, not merely at the end once everything has
settled. A best-effort prune (`pruneOlderRevisions`, ignoring its own errors) deletes now-superseded
revisions after each successful publish so a long run's many incremental per-assistant-event writes
don't accumulate unbounded files per key; a failed prune just leaves a harmless stray file; it can
never affect which revision a reader selects. See the "monotonic ledger publication" describe block
in `usageLedger.test.js`: a late-but-successful older rename sampled continuously throughout never
shows the stale value at any point; an older write's own publish failure (injected `EIO`) never
affects the already-published newer entry; and `listCardUsageEntries` still returns exactly one
entry per key — the freshest revision — never one row per revision.

`drainPendingUsageWrites()` waits for every currently in-flight write to settle; `runCard()` awaits
it (best-effort) before its own span is considered over, so a write dispatched fire-and-forget
mid-run can't race the run's own completion.

**Revision numbers are monotonic across board restarts, not just within one process (Round 6,
2026-09-12).** The `revision` embedded in each entry used to be a bare in-process counter
(`nextWriteSequence`, starting at 0) with no persisted state at all. A restarted board process
starts that counter over from 0, so a pre-restart write that reached `rev6` would outrank a
post-restart write at `rev1` for the *same* entry — exactly backwards, and reachable whenever a
write targets the same entry across a restart (ordinary phase spawns never do, since each gets a
fresh invocation id — but a future replay/backfill tool that correctly reuses an entry's *original*
invocation id, per the no-default-invocation-id contract above, does exactly this).

`revision` is now the composite `{epoch, sequence}`. `sequence` is the same per-process,
call-order counter as before. `epoch` is a per-`runsDir` integer persisted to
`<runsDir>/.usage-ledger-epoch.json` and bumped by exactly 1 the first time any write touches that
`runsDir` in this process's lifetime (`ensureEpoch`/`loadAndBumpEpoch`) — never by wall-clock time,
which can run backwards (NTP, WSL clock skew). Revisions compare `epoch` first, then `sequence`, so
ANY write from a newer process outranks EVERY write from an older one for the same entry,
regardless of their respective sequence numbers, while ordering within one process (one fixed
epoch) is exactly the prior sequence-only behavior.

Call order still defines recency within a process, which is the property the spec is strictest
about: `sequence` is assigned synchronously at `recordAttemptUsage`'s entry, before any `await`, so
a later call always outranks an earlier one even if the earlier call's I/O resolves later. `epoch`
is resolved asynchronously (it has to be — it's a disk read) via a Promise memoized per `runsDir`
in `ensureEpoch`: the *first* call against a given `runsDir` in this process starts
`loadAndBumpEpoch` and caches its pending Promise synchronously, before any `await` runs, so every
other call sharing that `runsDir` — no matter when each one happens to call `ensureEpoch` — observes
and awaits that exact same cached Promise rather than separately reading-and-bumping the file
itself (which would both race on the read and risk each process-local write seeing a different
epoch value). Because every write in one process resolves to the identical epoch value, deferring
its resolution past an `await` never reorders two same-process writes — they're still ordered
entirely by their synchronously-assigned `sequence`. The epoch bump deliberately always uses the
real `fs.readFile`/`fs.writeFile`/`fs.mkdir`, never `recordAttemptUsage`'s own caller-injectable
`readFileFn`/`writeFileFn`/`mkdirFn` — those exist so a test can gate or fail *that call's own*
entry write, and routing the epoch sidecar through them would gate or fail every other racing call
that shares the same cached epoch promise too, needlessly coupling two unrelated concerns.

A restart is simulated in tests via `resetUsageLedgerProcessStateForTests(runsDir)` — a test-only
hook that clears both the in-memory `nextWriteSequence` and the cached epoch for `runsDir`, so the
next write re-derives its epoch from the persisted sidecar (bumping it past whatever value this
"process" already wrote) exactly as a genuinely restarted board would. See the "revision numbers
survive a board restart" describe block in `usageLedger.test.js`: a write issued after a simulated
restart outranks a pre-restart write for the same entry; a replay that reuses the original
invocation id after a restart is visible to readers and the stale pre-restart revision is pruned;
two concurrent writes immediately after a restart still get distinct revisions with the later call
winning; and the pre-existing late-rename monotonic-publication guarantee still holds once a
restart has happened in between.

**The claimed epoch survives a lost, damaged, or never-written sidecar, and is claimed atomically
(Epoch robustness, 2026-09-12).** Round 6's `loadAndBumpEpoch` trusted the sidecar alone: it read
`<runsDir>/.usage-ledger-epoch.json` (0 if missing/unreadable/malformed) and persisted `stored + 1`
with a plain `writeFile`, with no exclusive claim over that value. Both halves were exploitable —
reproduced independently of the round-6 test suite, all four cases against the *same* entry a
replay/backfill correctly reuses an invocation id for:
- Losing, truncating, or corrupting the sidecar between two processes made the second process
  re-derive the SAME epoch the first one already used (a truncated/empty/non-numeric-epoch sidecar,
  or one deleted outright) — its pre-restart revision then outranked the post-restart write.
- A first process whose sidecar *persist* silently failed (the standard best-effort posture) left
  no record at all for a later, disk-healthy process to build on — same collision.
- Two processes starting together, each first-writing the same entry concurrently, could both read
  "no epoch claimed yet" and both persist the same value — one process's terminal record was
  silently overwritten by the other's.

The fix has two independent halves, `loadAndBumpEpoch` now composes both:
1. **`highestEpochOnDisk`** scans every `*.rev<epoch>-<seq>.json` filename already in `runsDir`, for
   ANY entry, and returns the highest `<epoch>` found. Revision files are durable, first-class
   evidence of every epoch a process actually used to publish — unlike the sidecar, a single failed
   write can never truncate them. The claimed candidate is `max(loadStoredEpoch(runsDir),
   highestEpochOnDisk(runsDir)) + 1`, so a lost/damaged/never-written sidecar can only ever make the
   *sidecar's own* contribution read as 0 — it can never lower the candidate below what the
   revision files on disk independently prove was already used. One scan per process, for the
   whole `runsDir`, is a strictly larger set than "this one entry's own revisions" and so still
   satisfies the per-entry guarantee.
2. **`claimEpochAtomically`** claims that candidate via an exclusive create (`{ flag: "wx" }`) of a
   per-epoch claim file (`.usage-ledger-epoch.claim-<epoch>.json`); on `EEXIST` it retries the next
   integer up. Exclusive create is atomic at the filesystem level, so of two simultaneous attempts
   at the same candidate exactly one succeeds — closing the gap a plain read-then-write can't: two
   processes computing the identical candidate now walk away with two DIFFERENT claimed epochs, not
   the same one. `persistStoredEpoch` still writes the sidecar afterward (now via temp-file +
   rename, never a truncatable direct write) purely as a fast path for the next process to avoid
   rescanning revision files from epoch 0 — the claim files and the revision-file scan are what
   actually make the guarantee hold even when that sidecar write is lost. If the claim file itself
   can't be created at all (`EACCES`, `ENOSPC`, a read-only filesystem), usage recording falls back
   to the disk-seeded candidate unclaimed rather than ever throwing — still provably higher than
   everything already on disk, just without the exclusive-claim guarantee against another process
   hitting the identical failure at the identical instant. Claim files are never pruned (one small
   file per process start is an acceptable, permanent cost) — pruning risks removing the highest
   live claim and making an in-use epoch claimable again.

Both halves are deliberately real `fs.*` calls, never `recordAttemptUsage`'s own caller-injectable
`readFileFn`/`writeFileFn`/`mkdirFn`, for the same reason round 6 already establishes above. The
disk scan and claim happen once per process inside the same memoized `ensureEpoch` promise as
before — this does NOT reopen round 6's call-order rule: `sequence` is still fixed synchronously at
`recordAttemptUsage`'s entry, so a later call in one process still outranks an earlier one
regardless of how long the (per-process, one-time) epoch claim takes to resolve.

See the "epoch robustness" describe block in `usageLedger.test.js`: an empty, invalid-JSON, or
non-numeric-epoch sidecar between two simulated processes never lets the pre-restart revision
outrank the post-restart one; a deleted sidecar behaves identically; a silently-failed persist (a
directory placed at the sidecar's own path, so the final rename can never land) still lets a later,
disk-healthy process claim correctly; and two genuinely independent module instances (`vi.resetModules()`
+ a fresh dynamic `import()`, simulating two real processes racing rather than two calls sharing one
process's cache) claim distinct epochs when they first-write the identical entry concurrently, with
neither's revision file overwritten by the other's and the higher-epoch process's later terminal
record never overwritten or deleted.

**Aggregate cost is nullable (fix round, Codex review 3, 2026-09-12, finding 2).** Per-entry
`costUsd: null` ("unknown") was already correct (see above), but `attemptTotal`/`executionTotal`/
`cardCycleTotal` silently coerced an unknown entry's cost to `0` before summing — an execution total
of one 100-token entry with `costUsd: null` reported `costUsd: 0`, presenting "we never got a cost
figure" as a genuine measured zero, and a mixed collection presented its known subtotal as if it
were the whole. `sumEntries` (and the three totals built on it) now reports `costUsd: null` whenever
ANY contributing entry's own cost is unknown, alongside `knownCostUsd` (the subtotal of every entry
that DID carry a known cost) and `unknownCostEntries` (how many didn't) — a caller can present
"known subtotal, N entries unmeasured" instead of a misleadingly precise total. A measured `costUsd:
0` is reported only when every contributing entry's cost is known — all-known, unknown-only, and
mixed collections are each covered in `usageLedger.test.js`.

**No default invocation id (fix round, Codex review 3, 2026-09-12, recommendation).**
`usageLedgerEntryPath`/`recordAttemptUsage` used to fall back a missing/empty `invocationId` to a
fixed `DEFAULT_INVOCATION_ID`, silently sharing one key between any callers that omitted it —
exactly the same class of bug executionId hardening (finding 4, above) already closed for
`executionId`. Both ids are now rejected up front, before any path string is built, with the same
posture: no entry is ever written under a shared/default invocation key. There is no legacy-replay
caller yet (a future raw-log replay/backfill tool, tracked for T-0369, must recover each record's
*original* invocation id from the source run rather than mint a new one — otherwise it double-counts
the same consumption); when one exists, that identity is its own explicit input, never a silent
fallback.

## `recordAttemptUsage` wiring into `runOrchestrator.js`

A prior reviewer round FAILed this card on exactly the gap the section above used to describe:
`recordAttemptUsage` had no caller anywhere, so nothing was ever recorded for a real run, at any
termination. That gap is now closed. `RunOrchestrator` takes an injectable `recordAttemptUsageFn`
(default: `recordAttemptUsage` itself) and a private `_recordUsage` chokepoint
(`runOrchestrator.js`'s own docstring on that method) that every call site below goes through:

- **`_runPhase`** (shared by the implementer, reviewer, planner, and merge-conflict phases alike)
  records the three outcomes it alone can classify without any caller-side verdict —
  `cancelled`, `phase_timeout` (covers both the phase-timeout ceiling and the inactivity watchdog,
  since both set `result.timedOut`), and `crashed` — each `complete: false`, a lower bound. It
  also fires one **incremental** record per `assistant` event mid-phase (`outcome: "in_progress"`,
  `complete: false`) — the "recorded incrementally, not only at termination" half of the
  acceptance criterion, and the only protection against a kill this orchestrator never observes
  (a board-process crash, an OOM-kill) recording as zero rather than a real partial figure. A
  clean exit (`exitCode === 0`) is deliberately **not** recorded inside `_runPhase` itself — that
  case still needs the caller's own classification below, so each phase key ends up with exactly
  one terminal entry, never two disagreeing ones.
- **The implementer phase's caller** (`_runAttempt`), on a clean exit, records `quota_stop` (a 429
  session-limit signature found via `usageLimitDetector.js`'s `eventsContainUsageLimitSignature`)
  or `success` — both `complete: true`, since a quota-stop's `result` event still carries a real
  cumulative total, not a lower bound.
- **The reviewer phase's caller**, after `crossCheckVerdictFn` produces the final verdict, records
  `quota_stop` (same detection, checked first — a 429 alongside a self-reported PASS/FAIL is still
  a quota stop, not a graded verdict), `success` (verdict `PASS`), or `reviewer_fail` (every other
  verdict, `FAIL` and `NEEDS_HUMAN_DECISION` alike — both are a completed, real reviewer verdict,
  not a truncation). This one code path covers FAIL-with-retry and FAIL-exhausted identically:
  the ledger records per real attempt number regardless of whether the loop goes on to retry or
  stop, so it never needs to know which.
- **The planner's own success/failure** (`_planUnassignedCard`), on a clean exit, records
  `success`/`quota_stop` at `attempt: 0` — planning runs once, before the implementer/reviewer
  attempt loop even starts, so it never carries a loop attempt number.
- **The merge-conflict phase's caller** (`_syncBranchWithDevelop`), on a clean exit, records
  `success`/`quota_stop` at `attempt: 0` — same reasoning as the planner: develop-sync runs once
  per PASS, outside the implementer/reviewer retry loop. This call sits right after the
  `exitCode !== 0` check, same position as every other phase's own record, and covers both ways
  the phase can finish cleanly (a merge fully resolved and pushed, or one this method's own
  `stillUnresolved`/`dirty` check later decides was left incomplete) — that follow-on business
  check is a separate FAIL-style reason surfaced on the card, not a different usage
  classification: the phase's own process still ran to completion either way. Fixed in this
  round: this caller did not exist before, so a resolved merge-conflict phase's ledger entry was
  stuck at its last incremental `in_progress`/`complete: false` record forever.

Every `_recordUsage` call is fire-and-forget (`void`, never `await`ed by its caller): this is
instrumentation, and a disk-I/O hiccup (or, in tests, a call to a filesystem path that doesn't
exist) must never add latency to — or ever be capable of failing — the run it's describing. The
underlying `recordAttemptUsageFn` call itself still happens synchronously at that point in the
control flow (calling a function evaluates its arguments and invokes it immediately, before any
`await` on its result), so nothing about this weakens "recorded... at every termination": the
write is *dispatched* at the exact moment of termination, it just isn't blocked on.

`retry` is always `0` in every call site above: this orchestrator has no sub-retry loop within a
single phase execution today (only the outer attempt loop, which maps onto `attempt`), so there is
nothing yet for a nonzero `retry` to distinguish. The ledger's key schema already supports it for
whenever that changes.

Every `_recordUsage` call also now passes `sourceLogPath: runLog.path` (fix round, Codex review
2026-09-12, P1 — previously not passed at all, leaving every recorded entry's `sourceLogPath` field
`null`), and `_recordUsage` looks up the run's own execution id from a `taskId -> executionId` map
populated once at the top of `runCard()` (see "Execution identity" above).

`_runPhase` also mints the phase's `invocationId` (see "Invocation identity" above) and threads it
through both its own internal `_recordUsage` calls and the returned result object
(`{...result, events, cancelled, invocationId}`); every caller's own terminal `_recordUsage` call
above reads `<phaseResult>.invocationId` off that return value rather than generating its own, so one
phase's incremental and terminal records always share one invocation id.

See `runOrchestrator.usageLedger.test.js` for the dedicated spec covering every case above:
PASS records `success` for both phases; a retryable reviewer FAIL records `reviewer_fail` then a
fresh `success` pair on the next attempt; an implementer crash records `crashed`; `cancelRun`
records `cancelled`; an inactivity-timed-out phase records `phase_timeout`; a clean-exit phase
whose events carry a 429 session-limit result event classifies as `quota_stop` rather than
`success`; the planner phase records at attempt 0; a resolved merge-conflict phase records
`success` at attempt 0; an incremental (`complete: false`) record
lands mid-phase, before any terminal outcome; every recorded entry across a run shares one
execution id, minted before the first process spawns and cleared on normal completion; pending
usage writes are drained before `runCard()` returns; and an instrumentation failure
(`recordAttemptUsageFn` rejecting on every call) never changes the run's own verdict. Its
crash-recovery describe block (fix round, Codex review 2, 2026-09-12, finding 2) drives the
orchestrator through real (unmocked) `recordAttemptUsage`/`ensureExecutionId` across two separate
`RunOrchestrator` instances sharing one `runsDir`, to reproduce and pin an actual board restart: an
interrupted implementer phase's entry survives, untouched, alongside the restarted phase's own
entry, both under the same recovered execution id but distinct invocation ids.

## Draining on board shutdown, not just run completion

Fix round 3 (2026-09-12) closed a gap the round above didn't cover: `runCard()`'s own `finally`
(above) only drains pending usage-ledger writes when a *run* finishes normally. Nothing drained on
an actual board-*process* shutdown, and — worse — nothing in production called the board's
`close()` at all. `serviceRestart.js`'s auto-restart and `deploy.sh` both stop the systemd unit with
`systemctl --user restart/stop`, i.e. a plain `SIGTERM`, and `tools/board/src/server/index.js`
installed handlers only for `uncaughtException`/`unhandledRejection` — so Node exited on that signal
without running any cleanup, and a terminal write dispatched fire-and-forget
(`void this._recordUsage(...)`) mid-write at exactly that moment could be lost. That is precisely
the quota-stop/crash/restart shutdown this ticket exists to measure, so losing the terminal figure
there defeats the point.

Two pieces close it:

- **`boardServer.js`'s `close()`** now awaits a bounded drain (`drainUsageWritesBestEffort`,
  default `usageDrainTimeoutMs: 3000`, overridable via `BOARD_USAGE_DRAIN_TIMEOUT_MS` or the
  `startBoardServer` options for tests) before closing the HTTP server and DB — the drain runs
  while the process can still do I/O, not after. A timed-out or rejecting drain is logged
  (`console.warn`) and swallowed, never thrown: this is instrumentation, so it must never block
  shutdown past its bound or change any card's verdict.
- **`index.js`** installs `SIGTERM`/`SIGINT` handlers that `await board.close()` (which now
  includes the drain above) and then `process.exit(0)` — the actual call site auto-restart and
  deploys were missing. A rejecting `close()` is logged but still followed by the exit, so a
  shutdown-time instrumentation failure can never wedge the process past the signal it was asked to
  stop for. The bound is kept comfortably inside this board's known 90-second final-SIGTERM systemd
  timeout.

See `boardServer.test.js`'s "usage-ledger drain on shutdown" suite and `server/index.test.js`'s
"orderly shutdown on SIGTERM/SIGINT" suite: an in-flight terminal write is on disk with its correct
tokens/outcome/`complete` flag by the time `close()` resolves; a drain held open past its bound
still lets `close()` finish within that bound; a rejecting drain never throws out of `close()`; and
both signal handlers call `close()` then exit, including when `close()` itself rejects.
