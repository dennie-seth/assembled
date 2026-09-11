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
  which all carry one. This is why the reader below falls back to the *log file's* mtime rather
  than an event-level timestamp.

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
| Observation timestamp | No event carries its own wall-clock field. The reader uses the *run log's mtime* as the observation instant — sound when the matching event is the newest line in the log (the common case, `status:allowed`/`allowed_warning` roughly every turn); an underestimate of true age when the matching event was only found via the head-of-file fallback in a still-growing log (see `usageWindow.js`'s existing head-read rationale) — the tail was written more recently by *other* events, so mtime looks newer than the specific matching event actually is. This is the reader's one open imprecision; see `foundVia` on each reading. | Same mechanism. Weekly events are much sparser (once per ~week's worth of runs vs. once per turn), so the head-fallback path is the *normal* path here, not the exception — the imprecision above applies more often to this window than to the 5-hour one. |
| Reset semantics | `resetsAt` (unix seconds) is the instant this specific window's cap frees up. Verified (not inferred from the phrase "5-hour window"): `usageWindow.js`'s `utilizationFromRateLimitInfo` already treats `now >= resetsAt*1000` as an elapsed window reading as fresh, and that behavior is unchanged here. Each window's `resetsAt` is read from its *own* matching event only — a `five_hour` reading never inherits or is reset by a `seven_day` event's `resetsAt` or vice versa (see "read independently" below). | Same semantics, own `resetsAt`. |
| Maximum acceptable staleness | 15 minutes (`DEFAULT_MAX_STALENESS_MS.five_hour`) — measured, not asserted: `tasks/.runs/T-0366-2026-09-11T18-15-10-554Z.jsonl` records seven consecutive `five_hour` readings in one continuous session at lines 1/21/61/158/164/200/235. Using the nearest neighbouring `assistant`/`user` event's own `timestamp` field as each reading's observation instant (lines 5/22/62/159/165/199/234 respectively), the gaps between consecutive readings run ~9s, ~33s, ~1m42s, ~4s, ~2m20s, ~1m58s — the worst observed gap is ~2m20s. 15 minutes is >6x that worst observed gap, not a placeholder. | 2 hours (`DEFAULT_MAX_STALENESS_MS.seven_day`) — also measured: the one within-session repeat observed, `tasks/.runs/T-0367-2026-09-11T23-06-33-652Z.jsonl` lines 1 and 287 (same session `c3cf5aa3-...`), are ~5m8s apart (23:06:41 → 23:11:49, using the neighbouring `assistant` timestamp at line 6 as the session-start anchor and the tool-result timestamp at line 288 for the second reading); across separate orchestrator runs of this same card the gap widens to about an hour (that file's companion log, `T-0367-2026-09-11T22-06-33-812Z.jsonl`, created exactly one hour earlier, also opens with its own `seven_day` reading at line 1). 2 hours sits above both observed gaps. Both constants are exported and overridable per call; tightening them is a config change, not a code change. |

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

## Classification: measured / estimated / stale / unavailable

Every reading `readWindowUsage`/`readUsageTelemetry` returns is one of exactly four
classifications, so a caller can never mistake a policy stand-in for a real number, or a merely-old
reading for a genuinely-missing one:

- **`measured`** — the event carried an explicit, in-range (`0..1`) numeric `utilization`, and the
  reading is fresh (age ≤ the window's max staleness). This is real telemetry, not a guess.
- **`estimated`** — no numeric `utilization` was present, so the reading falls back to the same
  status-only stand-in `usageWindow.js` already uses (`allowed`→0, `allowed_warning`→0.9,
  `rejected`→1, elapsed-reset→0). Still fresh. **A status-only `allowed` event is always
  `estimated`, never `measured`** — the zero it reports is a policy floor, not a measurement of
  zero usage, and collapsing that distinction was exactly the bug this card exists to fix.
- **`stale`** — a matching event was found, but its observation age exceeds the window's max
  staleness. The numeric `utilization` is deliberately **not** surfaced as usable in this case
  (`utilization: null`) — "unknown or stale capacity must never silently become unlimited" means a
  stale `allowed` must not read the same as a fresh one to any downstream gate.
- **`unavailable`** — no event matching this window's `rateLimitType` was found anywhere in the
  scanned logs, or its `status` was unrecognized (a CLI value this reader has never seen). Also
  `utilization: null`. Distinguished from `stale` in the reading's `reason` string and in which of
  `logPath`/`observedAtMs` are present (both `null` for `unavailable`, both populated for `stale`).

## The idempotent usage ledger

`runLog.js` retains every event verbatim in `tasks/.runs/*.jsonl` already — the ledger does not
duplicate that; it stores a **derived summary**, one JSON file per `(card, attempt, phase, retry)`
key (`tasks/.runs/<cardId>-attempt<N>-<phase>-retry<N>.usage.json`, mirroring `runState.js`'s
`<taskId>.runstate.json` sidecar convention), always computed fresh from the full event list rather
than accumulated as deltas. Recomputing from scratch on every call is what makes recording
idempotent by construction: calling `recordAttemptUsage` twice with the same events overwrites the
same file with the same content, never doubling a running total. Recording again with a **longer**
events array (the normal "incrementally, and again at termination" case) simply recomputes and
overwrites with the fuller picture — still one file, still one number, per key.

**Never add per-message usage to a cumulative final result.** Each `assistant` event's
`message.usage` reflects that one API call. The final `result` event's `usage`/`total_cost_usd` is
already the *cumulative* total for the whole attempt. `summarizeUsageFromEvents` treats these as
mutually exclusive, not additive: when a `result` event is present, its numbers are authoritative
and the per-message sum is discarded entirely; only when no `result` event exists at all (a
crash, cancel, or phase-timeout truncation) does the per-message sum become the recorded figure —
explicitly tagged `usageSource: "incremental"` rather than `"result"`, so a reader can tell a real
completed total from a lower-bound estimate of an interrupted one at a glance.

Outcome and completeness are supplied by the caller (the orchestrator knows *why* an attempt
stopped feeding events — success, quota-stop, reviewer FAIL, cancel, crash, or phase timeout; the
ledger does not re-derive that from raw events). `complete: false` on cancel/crash/timeout is what
marks a recorded figure a lower bound rather than a finished attempt's cost.

Attempt totals sum every phase/retry recorded for one `(card, attempt)` pair; card-cycle totals sum
every attempt recorded for a card. Both are computed on read (`attemptTotal`/`cardCycleTotal` over
`listCardUsageEntries`), not stored redundantly, so there is nothing to keep in sync.

## Out of scope for this card

`recordAttemptUsage` has no caller yet — a deliberate module-boundary cut, not an oversight.
Recording usage would not itself violate "no launch, admission, or poller behaviour changes"
(writing a derived sidecar file is not a launch/admission/poller decision); the reason to defer is
narrower than that. Wiring it in correctly means finding every one of `runOrchestrator.js`'s
termination paths — PASS, FAIL-with-retry, FAIL-exhausted, `cancelled`, `crashed`, `_blocked`
timeout, the inactivity-timeout-treated-as-retryable-FAIL case, and the planner's own
success/failure — and threading the right `{cardId, attempt, phase, retry}` plus `outcome`/
`complete` pair through each one. `runOrchestrator.js` has no existing test seam for asserting "a
usage sidecar was written here" at each of those points; adding one under TDD, per
`.claude/rules/conduct.md`, for every termination path is realistically its own card's worth of
work, and touches the same retry/preservation logic (`_runAttempt`, `_handlePass`, `_blocked`)
this evidence-only ticket promises not to perturb. A follow-up card — after T-C's cost estimator
exists as the first real consumer of recorded attempt usage — should wire `recordAttemptUsage`
into each termination path with dedicated tests per outcome. Until then, this module is correct
and tested in isolation but inert in the live run; that narrowing is stated here explicitly so a
human reviewer can accept it rather than discover it.
