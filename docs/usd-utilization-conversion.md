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
reviewer's 2026-10-16T18:39 VALIDATION pass found that claim contradicted by the recorded evidence,
and a direct re-scan of `tasks/.runs/` (via `scanRateLimitReadings`, grouped by `resetsAt`) settles
exactly how much evidence exists: the real history has precisely **two** distinct `seven_day`
reset cycles with two or more measured readings at all, never more. One is the shipped sample
above; the other, `resetsAt 1790200800`, spans `2026-09-18T23:36:29.105Z` →
`2026-09-23T06:11:15.534Z`, has 76 readings, and shows a real 0.49 utilization increase -- a
genuine candidate, not a reading-count shortage. It never becomes a second sample because of
`deriveRateSamplesForWindow`'s all-or-nothing censoring rule
(`usdUtilizationConversion.js`: "A cycle is dropped ... when ... ANY ledger entry inside its
interval is censored") -- if even one usage-ledger entry recorded during a candidate cycle's
interval has `costUsd: null`, the whole cycle is discarded rather than approximated from a
partial, artificially-low subtotal. This one candidate cycle's interval contains exactly **5**
such entries: `2026-09-19T12:51:19.984Z`, `2026-09-19T15:02:21.990Z`, `2026-09-19T15:06:17.593Z`,
`2026-09-21T13:31:43.353Z`, `2026-09-21T14:12:42.911Z` -- a censoring-driven gap, not a
reading-count gap. (Repo-wide, as of this fit, `tasks/.runs/` carries 14 usage-ledger entries with
`costUsd: null` in total, spanning `2026-09-17T01:08:55.184Z` through `2026-10-03T13:36:43.584Z`;
the 5 above are the ones that actually matter here, since they're the only ones landing inside
this one at-risk cycle's own interval -- the other 9 fall outside it and have no bearing on
`seven_day`'s fit.) Loosening the censoring rule to recover this cycle anyway is exactly the
"approximate the true spend from a known lower bound" shortcut `deriveRateSamplesForWindow`'s own
docstring rejects: a rate derived that way would be systematically biased low, which is worse than
honestly holding `units_not_comparable`. One sample is nowhere near
`MIN_SAMPLES_FOR_USABLE_CONVERSION` (5); `fitConversionFromSamples` marks it `usable: false` with
that reason, and `resolveUnitConversionForAdmission` resolves `seven_day` to `null`.

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

## How to re-fit

`deriveUsdUtilizationConversionFromRuns({ runsDir: "<repo-root>/tasks/.runs" })` re-runs this exact
pipeline against whatever evidence exists at call time -- no code change required, only a new
`fitDate` and a human review of the result before it replaces
`DEFAULT_USD_UTILIZATION_CONVERSION`. Re-fit periodically (e.g. whenever
`docs/wip-gate-admission.md`'s "how to enable safely" runbook calls for it) and especially once
`seven_day` has accumulated more reset cycles whose full interval's usage-ledger spend is
uncensored -- that, not a shortage of multi-reading cycles, is what stands between it and clearing
`MIN_SAMPLES_FOR_USABLE_CONVERSION`.
