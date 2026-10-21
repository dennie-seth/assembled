# USD-per-utilization-unit conversion: derivation, evidence, and honest limits

**T-0402.** This is the conversion `docs/wip-gate-admission.md`'s own flag section named as the
reason `WIP_GATE_ENFORCEMENT_ENABLED` could not be turned on: `admissionDecision.js`'s
`evaluateWindowAdmission` compares a USD cost estimate against a `utilization_fraction` window
budget, and without a versioned, recorded-evidence rate to bridge the two units, every real
comparison held `units_not_comparable`. `tools/board/src/runner/usdUtilizationConversion.js` is
the mechanism; this document is the evidence and the finding.

## Where the evidence lives, and why it's cited here rather than read live

Exactly the same situation as `docs/usage-telemetry.md`'s own "Provenance" section: `tasks/.runs/`
is a runtime-only, gitignored directory that starts empty in a fresh worktree or CI checkout. The
real evidence -- 1233 files, 623 of them `*.jsonl` run logs and 436 deduplicated usage-ledger
entries -- lives at `/home/dennieseth/dev/assembled-board/tasks/.runs/` on the dev machine, read
directly (via a `node -e` one-liner doing its own `fs` calls, since the harness's own `Read`/`Glob`/
`ls` tools are sandboxed to the current worktree -- see this repo's own
`reference-worktree-filesystem-sandbox` memory note) in the same session that wrote this file and
`usdUtilizationConversion.js`'s `DEFAULT_USD_UTILIZATION_CONVERSION`. The derivation pipeline
(`deriveUsdUtilizationConversionFromRuns`) is real, committed, reusable code -- it can be re-run
against the live `tasks/.runs/` at any time (see "How to re-fit" below) -- but its one real
production run's result is pinned as a committed constant for the same reason
`DEFAULT_ADMISSION_CONFIG` is a constant: the evidence it reads isn't available at test/CI time.

## The method, and why the obvious one doesn't work

The naive approach -- take every pair of *adjacent* measured `rate_limit_event` readings for a
window and divide the USD spent between them by the utilization increase -- was tried first and
rejected. `utilization` is only ever reported to about two decimal places, so an adjacent pair is
usually only 1-2 percentage points apart; inverting that small, coarsely-quantized a denominator
amplifies noise enormously:

| Window | Method | Samples | Rate range (USD / unit) | Mean | Coefficient of variation |
|---|---|---|---|---|---|
| `five_hour` | adjacent-pair | 3 | 88.0 - 1002.9 | 483.4 | **0.97** |
| `seven_day` | adjacent-pair | 17 | 40.4 - 821.7 | 210.5 | **0.85** |
| `five_hour` | **reset-cycle** (chosen) | 5 | 55.1 - 144.4 | 86.4 | **0.40** |
| `seven_day` | **reset-cycle** (chosen) | 1 | 376.5 | 376.5 | n/a (one sample) |

The chosen method (`deriveRateSamplesForWindow`) instead takes the FIRST and LAST measured reading
within one reset cycle (every reading sharing one `resetsAt`) -- spanning a much larger, less
quantization-dominated utilization range per sample, at the cost of needing at least two readings
in the same cycle to produce a sample at all. This is a straightforward noise/sample-count
trade-off, and the table above is the actual, direct evidence for which side of it won: the
reset-cycle method's coefficient of variation for `five_hour` (0.40) is in line with this
project's own existing tolerance for uncertainty -- `costEstimator.js`'s `TYPE_PRIORS` carry
uncertainty-to-value ratios of 0.4-0.6 across every registered type -- while the adjacent-pair
method's (0.97, 0.85) is not.

Every sample additionally requires: at least two readings in the cycle; a genuine utilization
*increase* (a flat or decreasing pair is noise or a reset mid-cycle, and is dropped); and the
cycle's own interval to carry known, uncensored spend in the usage ledger -- a cycle with even one
censored (`costUsd: null`) entry in its interval is dropped entirely rather than approximated from
a smaller-but-known subtotal, since that subtotal is a lower bound that would bias the rate low,
never a safe stand-in for the true spend. A cycle with no recorded spend at all in its interval is
also dropped (a zero/negative rate is never fabricated).

The USD side sums **every** usage-ledger entry recorded anywhere on the board within a cycle's
interval, never scoped to one card: the five-hour/weekly rate-limit pool is global to the account,
shared by every card (and, invisibly to this ledger, by manual sessions and other hosts -- the
same reason `docs/wip-gate-admission.md`'s admission formula sets aside a separate
`externalBurnAllowance`).

## The real result (fitted 2026-10-16)

### `five_hour` -- usable

5 reset-cycle samples, spanning `2026-09-17T20:52:57.940Z` to `2026-09-30T16:10:45.255Z`:

| Cycle end | Readings in cycle | Ledger entries | Δutilization | Δspend (USD) | Rate (USD/unit) |
|---|---|---|---|---|---|
| 2026-09-17T21:05:50.744Z | 10 | 1 | 0.08 | 7.11 | 88.86 |
| 2026-09-18T14:11:20.381Z | 14 | 3 | 0.09 | 6.97 | 77.46 |
| 2026-09-19T15:48:43.469Z | 11 | 2 | 0.09 | 12.99 | 144.38 |
| 2026-09-20T20:28:14.123Z | 11 | 3 | 0.09 | 5.96 | 66.24 |
| 2026-09-30T16:10:45.255Z | 11 | 1 | 0.09 | 4.96 | 55.15 |

n=5 (at `MIN_SAMPLES_FOR_USABLE_CONVERSION`), mean 86.42, stddev 34.75, **coefficient of variation
0.402** (at/under `MAX_COEFFICIENT_OF_VARIATION` = 0.5) → **usable**. The point estimate shipped as
`usdPerUtilizationUnit` is the **median**, 77.46 (not the mean, which the single `144.38` outlier
cycle pulls upward) -- robust to exactly the kind of single-cycle noise a 5-sample pool can't
average away on its own.

### `seven_day` -- not usable, and this card does not invent a rate for it

Only **one** reset cycle in the real history produced a usable rate sample
(`2026-09-12T23:47:01.296Z` → `2026-09-15T08:51:03.630Z`, 35 readings, 27 ledger entries, rate
376.50 USD/unit). An earlier draft of this note claimed every other weekly cycle had at most one
measured reading, so there was no second point to measure an increase against -- the T-0402
reviewer's 2026-10-16T18:39 VALIDATION pass found that claim contradicted by the recorded evidence:
several later weekly cycles (readings spanning 2026-09-18 through 2026-09-23, sharing `resetsAt`
values on the same 604800s weekly boundary) do have two or more measured readings. What actually
drops them is `deriveRateSamplesForWindow`'s all-or-nothing censoring rule
(`usdUtilizationConversion.js`: "A cycle is dropped ... when ... ANY ledger entry inside its
interval is censored") -- if even one usage-ledger entry recorded during a candidate cycle's
interval has `costUsd: null`, the whole cycle is discarded rather than approximated from a
partial, artificially-low subtotal. The real history has enough censored ledger entries landing
inside those later cycles' intervals that none of them survives to become a second sample -- a
censoring-driven gap, not a reading-count gap. Loosening the censoring rule to recover those
cycles anyway is exactly the "approximate the true spend from a known lower bound" shortcut
`deriveRateSamplesForWindow`'s own docstring rejects: a rate derived that way would be
systematically biased low, which is worse than honestly holding `units_not_comparable`. One sample
is nowhere near `MIN_SAMPLES_FOR_USABLE_CONVERSION` (5); `fitConversionFromSamples` marks it
`usable: false` with that reason, and `resolveUnitConversionForAdmission` resolves `seven_day` to
`null`.

**This is the card's explicit finding, not a gap the card papers over**: the task's own
instructions are "do not invent a rate to make a test pass; if the recorded evidence cannot
support one, report that as the finding" -- for `seven_day`, today, it cannot. A healthy `five_hour`
window with a real conversion does not retroactively make `seven_day` comparable; the two windows
are evaluated, and now converted, completely independently (`admissionDecision.js`'s
`evaluateAdmission` narrows `unitConversion` per window kind precisely so one window's evidence
can never be borrowed by the other). Until a later re-fit accumulates enough `seven_day` reset
cycles with uncensored spend data across their full interval (see above -- readings are not the
scarce ingredient here, clean cost data is), `seven_day` keeps holding `units_not_comparable`, on its own --
visible on every decision's `admission.windows.seven_day` -- and because `evaluateAdmission` only
admits when EVERY window admits, a real `auto` launch under enforcement will still be refused
overall on `seven_day`'s own, separately honest hold -- proven directly in
`wipGateAutoManualIntegration.test.js`'s T-0402 integration test, through the real, unmocked
pipeline. A draft of this card briefly tried treating `UNITS_NOT_COMPARABLE` alone as a non-veto
so `five_hour`'s own fit could admit the aggregate anyway; @DennieSeth's review of PR #449
rejected that after measuring it against the committed default (a fully-consumed `seven_day`
window with no conversion still let the launch through). A window that can't be compared with
the estimate is an unresolved unknown, not an absent window, so that carve-out was reverted and
the aggregate stays strict.

## T-0457: the origin of `costUsd: null`, and why fixing it still doesn't unblock `seven_day`

T-0402's reviewer established that `seven_day` is unfittable because of censoring, not scarcity of
*readings*. This card re-ran the exact pipeline against the real, larger `tasks/.runs/` evidence
that exists today (2026-10-21 -- 1291 files, 475 deduplicated usage-ledger entries, up from the
436 cited above) via the same `node -e` technique T-0402 used (see "Where the evidence lives"
above), to answer two questions this card's acceptance criteria require answered from the real
ledger, not assumed: why do entries end up censored, and does fixing that actually get `seven_day`
to `MIN_SAMPLES_FOR_USABLE_CONVERSION`?

**Re-verification first, because it matters for everything below**: re-running
`deriveUsdUtilizationConversionFromRuns` against today's evidence reproduces the committed
`DEFAULT_USD_UTILIZATION_CONVERSION` for **both** windows byte-for-byte -- `five_hour`'s 5 samples,
`usdPerUtilizationUnit: 77.45769000000003`, `cv: 0.4021426187372661`, and `seven_day`'s 1 sample at
376.497433, unchanged. Five more days of real launches have not changed either number: no new
`five_hour` cycle cleared, and `seven_day` is exactly where T-0402 left it. This card's finding
does not require touching the committed constant at all.

### Why entries end up with `costUsd: null`

As of this run, **15 usage-ledger entries carry `costUsd: null`**, spanning 2026-09-17 through
today (2026-10-21 -- one of the 15 is this very run's own still-in-flight implementer phase; the
set has visibly drifted since whatever earlier snapshot this card's own History section cited: a
few entries that were null then have since resolved to a known cost on a later revision for the
same key, while new ones have appeared past 2026-09-30, which is itself evidence for this card's
"approximation drifting over time" edge case -- a null census is a moving target, not a fixed
fact). Every one of the 15 shares `complete: false` and a non-terminal `outcome`
(`cancelled`/`phase_timeout`/`in_progress`): T-0247 (09-29, cancelled), T-0361 (09-17,
phase_timeout), T-0384 ×3 (09-18 reviewer in_progress, 09-18 implementer cancelled, 09-19
implementer in_progress), T-0390 ×2 (09-19 phase_timeout, 09-19 cancelled), T-0403 ×2 (09-21
phase_timeout, 09-21 cancelled), T-0408 (09-24, cancelled), T-0423 ×2 (09-30 in_progress ×2),
T-0424 (10-01 reviewer, phase_timeout), T-0428 (10-03, cancelled), T-0457 (10-21, this run,
in_progress).

The mechanism (`usageLedger.js`'s `summarizeUsageFromEvents`, unchanged by this card): a session's
USD cost is **only ever reported in its terminal `result` event** (`total_cost_usd`); the
per-message `assistant` events that stream throughout a run never carry a cost figure at all, only
token counts. A phase that is cancelled, hits its wall-clock timeout, or is orphaned by a board
crash before the CLI emits that terminal event therefore has no cost figure *anywhere in its own
event stream* at the moment the ledger write happens -- `costUsd: null` is `usageLedger.js`
correctly, deliberately reporting "unknown", not a bug in `usageLedger.js` or
`usdUtilizationConversion.js` (neither file originates this null; both are already behaving
correctly given the `events` they were handed, confirmed by reading every one of the 15 entries'
own `sourceLogPath` in full).

Reading each of the 15 entries' own complete, final NDJSON log confirms two different causes,
not one:

- **13 of 15 never emit a terminal `result` event at all**, verified directly: T-0247, T-0361,
  both T-0384 implementer entries, both T-0390 entries, both T-0403 entries, T-0408, both T-0423
  entries, T-0428, and T-0457 (still running). These sessions' own CLI process genuinely never
  produced a cost figure anywhere -- not a capture bug, not recoverable by any means after the
  fact. This is the majority cause and it is permanent.
- **2 of 15 (T-0384's 09-18T11:34:51Z reviewer phase, and T-0424's 10-01T14:03:52Z reviewer phase)
  DO have a complete terminal `result` event in their full on-disk log**, with a real
  `total_cost_usd` ($8.229906800000004 and $3.643557 respectively) -- yet the recorded ledger entry
  still shows `costUsd: null`. This is a genuine, narrow capture-timing race: the child process
  finished and streamed its own terminal line to the log at essentially the same moment the board
  declared the phase `phase_timeout`/`in_progress` and finalized that key's usage entry from an
  `events` snapshot that predated the result line actually landing. The defect, such as it is,
  lives in **`runOrchestrator.js`'s** phase-finalization timing, not in `usageLedger.js` or
  `usdUtilizationConversion.js` -- both correctly summarize whatever `events` list they are given;
  neither is the file where this race could be fixed. `runOrchestrator.js` is outside this card's
  stated deliverable paths, so this card documents the finding (with exact cardId/timestamp/amount
  citations, above) as evidence for a future, separately-scoped card, rather than reaching into a
  file this card was not asked to touch.

Even setting scope aside: neither of those 2 recoverable entries would help `seven_day`. T-0384's
reviewer entry (09-18T11:34:51Z) falls outside every `five_hour` *and* every `seven_day` candidate
cycle's interval -- recovering it changes nothing in either window. T-0424's entry
(10-01T14:03:52Z) falls *inside* an otherwise-censored `five_hour` candidate cycle
(2026-10-01T13:54:47.719Z-14:12:15.396Z) -- recovering it would turn that cycle into a **6th**
`five_hour` sample, changing the committed fit this card must leave untouched. There is no
retroactive fix here that helps `seven_day` and is simultaneously safe for `five_hour`.

### The one `seven_day` candidate cycle, and why recovering it still isn't enough

`diagnoseCensoredCycles` (new in this card -- see `usdUtilizationConversion.js`) names exactly
which cycles censoring, specifically, drops. Run against today's real evidence for `seven_day`, it
reports exactly one: the reset cycle spanning 2026-09-18T23:36:29.105Z to
2026-09-23T06:11:15.534Z (76 readings, resetsAt `1790200800`). That interval has 94 ledger entries
with a known cost and **5 censored**: T-0384 implementer (09-19T12:51:19.984Z, in_progress), T-0390
implementer ×2 (09-19T15:02:21.990Z phase_timeout, 09-19T15:06:17.593Z cancelled), T-0403
implementer ×2 (09-21T13:31:43.353Z cancelled, 09-21T14:12:42.911Z phase_timeout). Every one of
these 5 is in the "13 of 15, no result event at all" group above -- **none of the entries blocking
this specific cycle are recoverable by any means**. This single candidate cycle's censoring is
therefore a true dead end today, not a capture bug waiting to be fixed.

But even a hypothetical perfect recovery of all 5 would only add a **second** `seven_day` sample
(the existing 2026-09-12 to 09-15 one, plus this one) -- nowhere near
`MIN_SAMPLES_FOR_USABLE_CONVERSION` (5). The real, deeper constraint, also established from the
real evidence: across the entire recorded history there have been 633 `seven_day` `rate_limit_event`
readings, and **521 of them (82%) carry no `receivedAtMs` at all** and are excluded by
`scanRateLimitReadings`'s own "untrusted timing" rule (3 more lack a numeric `utilization`). Of the
111 that remain, every single one shares one of only **two distinct `resetsAt` values** -- meaning
the entire recorded history contains exactly two weekly reset-cycle boundaries with two or more
timed readings at all, one of which already produced today's one sample. There have not yet been
enough DISTINCT weekly reset-cycle boundaries, each with enough timed readings, recorded for this
window to ever reach 5 -- a reading-*cycle* scarcity (not the reading-*count*-per-cycle scarcity
T-0402's reviewer already ruled out), compounding the censoring gap rather than being explained
away by it. No change to the censoring rule closes this; only more elapsed calendar time with the
instrumentation running, accumulating more weekly boundaries, does.

### Decision: no lower-bound approximation adopted

This doc already warns that "approximate the true spend from a known lower bound" is a shortcut
to justify, not take for granted. This card considered it directly for the one blocked cycle above
(treat its 94-entry known subtotal as the cycle's spend, ignoring the 5 unknowns) and declines it,
for two independent reasons, either one sufficient on its own:

1. **Zero benefit.** Even granting the shortcut, the cycle becomes `seven_day`'s 2nd sample, still
   three short of the floor of 5. It does not change `seven_day`'s `usable: false` verdict at all.
2. **An unwanted side effect on `five_hour`.** `deriveRateSamplesForWindow`'s censoring rule is
   shared by both windows -- there is no way to relax it "only for `seven_day`" without it also
   applying to `five_hour`'s own otherwise-censored 2026-10-01 candidate cycle (see above), which
   would grow `five_hour` from 5 to 6 samples and change its committed rate. That is exactly the
   "making the gate more permissive as a side effect" regression this card's own edge cases warn
   against: more admissions headroom with no corresponding improvement in `seven_day`'s evidence.

So the all-or-nothing censoring rule in `deriveRateSamplesForWindow` is unchanged by this card.
`seven_day` stays `usable: false`, honestly, with a now fully re-derived account of why: not a
single-cause censoring problem, but censoring compounding a reading-cycle scarcity that censoring
fixes cannot reach.

### Edge case: a rate fitted across a pricing change

This card's own edge cases call out a conversion averaged across samples billed at two different
prices as wrong even with enough samples, and ask how the window is bounded against it. Checked
directly rather than assumed:

**This repo never computes a price itself, so it cannot apply a stale one.** `usageLedger.js`'s
`summarizeUsageFromEvents` reads `costUsd` straight from the CLI's own terminal `result` event's
`total_cost_usd` field -- never from a token count multiplied by a price constant kept anywhere in
this codebase. Whatever Anthropic billed for a given call at the moment it happened is exactly what
lands in that entry's `costUsd`; there is no local price table here that could go stale.

**The real exposure is narrower: one fit's own point estimate blending samples recorded under two
different price regimes**, if a model's published price changed between two reset-cycle samples
that both feed the same median/mean. Re-running this card's own diagnostic directly against the
real evidence (`node`, the same `deriveRateSamplesForWindow` pipeline, reading each contributing
entry's own `models` field) shows every one of the 5 committed `five_hour` samples and the 1
committed `seven_day` sample already mixes `claude-sonnet-5` and `claude-opus-5` *within* a single
sample's interval. That is a cross-**model** blend (two different per-token prices active at the
same moment), not a cross-**time** pricing-change blend (one model's own price changing between
samples) -- a pre-existing property of the real evidence this card's acceptance criterion 4
requires leaving untouched, and a different axis from the one this edge case names.

**How the window is bounded against the time axis:**

- Every produced fit entry already carries its own `windowRangeStart`/`windowRangeEnd` -- the exact
  span its samples were drawn from, not an unbounded lifetime average. The committed `five_hour`
  fit spans 13 days (`2026-09-17T20:52:57.940Z` to `2026-09-30T16:10:45.255Z`); the one `seven_day`
  sample spans about 2.3 days. Short windows bound how much calendar time a mid-window price change
  would have to land inside to corrupt either fit.
- `deriveUsdUtilizationConversionFromRuns` always re-derives entirely fresh from whatever evidence
  exists at call time -- it never appends new samples onto an old committed table's existing ones.
  A re-fit therefore can't silently accrete a multi-month span that straddles more pricing changes
  than a reviewer looking at one `fitDate` would expect; each fit is one atomic snapshot.
- This repo keeps no record of Anthropic's own pricing/price-change history -- that lives entirely
  outside this codebase, so no check here can assert "no price change occurred inside this window"
  from code alone. That has to be a human judgment call at re-fit review time, same as the existing
  "a human review of the result before it replaces `DEFAULT_USD_UTILIZATION_CONVERSION`" step in
  "How to re-fit" below already requires. This card makes that check explicit: when a known pricing
  change for a model appearing in the evidence (an entry's own `models` field) is announced, treat
  it as a mandatory re-fit trigger, and reject a fit whose own `windowRangeStart`/`windowRangeEnd`
  straddles the change date rather than accepting one that silently averaged across it -- re-derive
  instead once enough post-change evidence exists on its own.

No code change accompanies this section: `CONVERSION_VERSION` is deliberately NOT bumped for this,
exactly per its own docstring ("a re-fit with the same method against newer evidence is a new
`fitDate`/`sampleCount`, not a new version") -- a pricing change is newer evidence to re-fit
against, not a change to the fitting method itself, and this card's acceptance criterion 4 forbids
touching the committed `five_hour` values regardless.

### What would actually change the verdict

Per T-0439's five-hour-only enforcement policy and this card's own scope (it must not change the
required-window set -- see `docs/wip-gate-admission.md`'s new T-0457 section): nothing here
changes behaviour today. A later `seven_day` re-fit becomes possible once more weekly reset-cycle
boundaries with 2+ timed readings accumulate in `tasks/.runs/` -- purely a function of elapsed
calendar time with this instrumentation running, not a code change. Separately, a future,
differently-scoped card fixing `runOrchestrator.js`'s phase-finalization event-snapshot race (see
above) would recover a handful of historical entries' true cost, but would not, on its own, close
the reading-cycle gap identified here.

## How to re-fit

`deriveUsdUtilizationConversionFromRuns({ runsDir: "<repo-root>/tasks/.runs" })` re-runs this exact
pipeline against whatever evidence exists at call time -- no code change required, only a new
`fitDate` and a human review of the result before it replaces
`DEFAULT_USD_UTILIZATION_CONVERSION`. `diagnoseCensoredCycles({ readings, ledgerEntries })` (T-0457)
is the companion diagnostic for exactly this review: call it with the same scanned readings/ledger
entries to see which candidate cycles censoring is still blocking and by how much, instead of
hand-rolling a one-off script against `tasks/.runs/` the way this card's own investigation
initially did.

Re-fit periodically (e.g. whenever `docs/wip-gate-admission.md`'s "how to enable safely" runbook
calls for it) and especially once `seven_day` has accumulated more reset cycles with two or more
timed readings each -- per T-0457's finding above, that (a shortage of DISTINCT weekly reset-cycle
boundaries with enough readings, not a shortage of readings within the one cycle that exists) is
now the dominant gap, compounded by -- but not solely explained by -- censoring of the one
candidate cycle that does exist.

Also treat a known Anthropic pricing change for a model that appears in the evidence (check each
candidate sample's contributing entries' own `models` field) as a mandatory extra re-fit trigger,
per the "edge case: a rate fitted across a pricing change" section above: reject a candidate fit
whose `windowRangeStart`/`windowRangeEnd` straddles the change date instead of accepting one that
silently averaged across it, and re-derive once enough evidence recorded entirely after the change
date exists on its own.
