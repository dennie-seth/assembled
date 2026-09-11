# Usage telemetry: verified source, per-window semantics, and staleness

**T-0367 (Ticket 1 / "T-A" of the WIP-gate set).** Evidence-only: this document and the
readers/ledger it describes change no launch, admission, or poller behaviour. They exist so
later cards (T-C cost estimator, T-D launch-boundary reservation) have a real, classified signal
to consume instead of the policy stand-ins `usageWindow.js` has used since T-0248/T-0295.

## Provenance of the claims below

Two different evidentiary tiers are cited here, and they are kept distinguishable on purpose:

1. **Already verified and committed**, before this card, from real `tasks/.runs/*.jsonl` payloads
   captured on live runs — see `usageWindow.js` (verified against Claude Code 2.1.241 on
   2026-09-04, payload captured verbatim from `tasks/.runs/T-0248-*.jsonl`) and
   `usageLimitDetector.js`/its tests (the T-0233 healthy-event false-positive, and the genuine
   429 rejection from `T-0233-2026-08-28T14-51-58-912Z.jsonl`). These are re-cited here, not
   re-derived.
2. **New for this card**, stated in the T-0367 task body itself as findings from a 2026-09-11
   review of `tasks/.runs/*.jsonl` on the machine that authored the spec
   (`wip_token_gate_spec_2026-09-11/SPEC_v2.md`): the `seven_day` window type, the numeric
   `utilization`/`surpassedThreshold` fields on warning events (values seen: 0.5, 0.53, 0.57, 0.9,
   0.91, 0.93), and the terminal shape of a quota stop (`terminal_reason: "api_error"`,
   `api_error_status: 429`, `result: "You've hit your session limit · resets <time>"`).

**Honesty note on tier 2:** `tasks/.runs/` is a runtime-only directory (see `.gitignore` /
`runOrchestrator.js`'s `runsDir` default) that is never committed and starts empty in a fresh
git worktree. This implementer session runs in exactly such a worktree (`worktrees/T-0367`) with
no history of live runs, so tier-2 claims could not be independently re-grepped from raw logs
here — they are taken as given from the task card, which states them as directly observed. If
that turns out to be wrong (a future run's log doesn't match), the reader below is built to fail
safe: an unrecognized `rateLimitType` or `status` value is classified `unavailable`, never guessed
at, and never silently treated as `unlimited`.

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
| Maximum acceptable staleness | **Policy, not measurement** — pending real inter-event interval data for this window, set conservatively at 15 minutes (`DEFAULT_MAX_STALENESS_MS.five_hour`), inside the ~once-per-turn cadence already established for this window by `usageWindow.js`'s comments. | 2 hours (`DEFAULT_MAX_STALENESS_MS.seven_day`) — wider because a healthy board can legitimately go a while between weekly-window events. Both constants are exported and overridable per call; tightening them is a config change, not a code change. |

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

Wiring `recordAttemptUsage` calls into `runOrchestrator.js`'s actual phase-completion points is
left to a follow-up: this card's acceptance is about the reader and ledger being correct and
tested against realistic fixtures, not about the live orchestrator calling them yet. Doing so here
would touch the orchestrator's hot paths under the same card that promises "no launch, admission,
or poller behaviour changes" — safer to land the evidence infrastructure first and wire it up as
its own reviewable diff.
