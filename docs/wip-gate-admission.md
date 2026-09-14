# WIP gate T-D: shared launch-boundary reservation and per-window admission

**T-0370 ("T-D" of the WIP-gate set).** Advisory-by-default: with the default configuration this
card changes no launch behaviour, only collects predicted-vs-actual evidence. Depends on T-0367
("T-A", telemetry + usage ledger, `docs/usage-telemetry.md`) and T-0369 ("T-C", cost estimator +
advisory logger). Unlike the card's first submission, enforcement (`WIP_GATE_ENFORCEMENT_ENABLED`)
is now fully implemented and tested, including the shared-boundary refusal and the overrun stop —
see "Enforcement flag" and "Overrun response" below. The flag itself still defaults OFF and this
card does not enable it on the live board; flipping it live is Dennie's call, later.

## Fix round (2026-09-14, Codex review of #387)

Codex's review of the card's first PR found seven gaps between the mechanism's own claims and
what the code actually did. All seven are fixed on this branch; this doc reflects the fixed state:

1. **Atomic check-and-reserve.** `launchAdvisory.js`'s `buildLaunchDecide` now runs
   read-active-reservations → evaluate-admission → write-own-lease as one turn under an in-process
   capacity lock (`withCapacityLock`), so two concurrent launches can never both compute admission
   against the same stale pool. A pool-listing failure, or one unreadable/malformed lease, makes
   the read indeterminate (`ReservationPoolReadError`) rather than an empty pool. Leases are now
   written via a temp file linked atomically into place (`fs.link`, not a bare `wx` write), so a
   crash mid-write can never leave a half-written lease visible.
2. **Enforcement wired to the shared decision.** See "Enforcement flag" and "Overrun response"
   below.
3. **Every pre-launch await is bounded.** `boundedAwait.js`'s `withTimeout` now bounds the
   poller's `readUsageTelemetry` read and `launchCardRun`'s `ensureExecutionId` read, not only the
   advisory `decide()` pipeline `withBoundedDecide` already bounded.
4. **Honest outcomes.** `usageLedger.js`'s `executionEndedSuccessfully` requires every ledger
   entry for an execution to be a successful, complete, known-cost entry before
   `reconcileLaunchOutcome` reports `costKind: "exact"` — `runCard` resolving (or rejecting) is not
   itself proof of success; a quota stop, a reviewer FAIL, and a cancellation all report a lower
   bound now.
5. **No orphan leases from timed-out work.** `withBoundedDecide` passes `decideFn` a cancellation
   token that flips true the instant it commits to a fallback, and persists the fallback itself
   via `recordAdvisoryDecisionFn` before resolving — so a late-settling decide() can never write a
   lease nothing will release, or leave a second, outcome-less record behind.
6. **Live reservations.** `launchAdvisory.js`'s `sumActiveReservedRemainingCostUsd` counts every
   other active reservation at its REMAINING future cost (reserved minus what its own execution
   already charged in the ledger), not its raw reserved amount.
7. **Real retry allowance.** `runOrchestrator.js`'s `effectiveMaxAttempts` is now a standalone
   exported helper shared by the runner's own auto-retry loop and the launch boundary, so the
   reservation always covers a card's actual `max_attempts` override, not a fixed default.

## The shared launch boundary

`launchCardRun` (`tools/board/src/runner/cardLaunch.js`) is the one path both the Run button
(`POST /api/tasks/:id/run`, `server/httpApi.js`) and the auto-launch poller
(`runner/autoLaunchPoller.js`) launch a card through. Every guard the Run button relies on lives
there — this card adds the admission/advisory/reservation machinery at the same point, right
before `orchestrator.runCard(id)` is actually called, so both launchers get it for free.

## Reservation ledger (spec §5) — `runner/launchReservation.js`

`reserveLaunchSlot` writes one lease file per launch, keyed by `(cardId, executionId,
invocationId)` — the same identity triple `usageLedger.js` uses. It writes a temp file to
completion first, then links it into its final path (`fs.link`, not a bare `wx` write or a
rename): the final path never exists until the content behind it is complete, and `link` still
fails with `EEXIST` when the final path already exists, which is what makes the *identical*-key
duplicate check atomic (`DuplicateReservationError`) — the filesystem itself arbitrates which
`link` wins. Two DIFFERENT launches never collide on the same lease file (each gets its own
uniquely-keyed one).

`listActiveReservations` throws `ReservationPoolReadError` — never returns `[]` — when the pool
directory can't be listed for a reason other than not existing yet, or when any one lease file is
unreadable/malformed; every caller (`buildLaunchDecide`'s admission read) must treat that as an
indeterminate read, not an empty pool.

**The read-check-reserve section is atomic.** `launchAdvisory.js`'s `buildLaunchDecide` runs
"list active reservations → sum their remaining cost → evaluate admission → write this launch's
own lease" as one turn under an in-process lock (`withCapacityLock`) — both launchers (the Run
button and the poller) live inside the one board process that holds board ownership
(`boardOwnership.js`), so an in-process lock is sufficient; a second board process never launches
concurrently against the same `runsDir`. Proven end to end through the real `launchCardRun`
boundary, not hand-composed primitives, in `cardLaunch.test.js`.

`releaseReservation` marks a lease released (idempotent) with the outcome it ended on.
`reconcileReservationsOnStartup` — wired into `boardServer.js`'s bootstrap, right after
`orphanReaper.reapOnStartup()` — releases any lease whose card is no longer `in-progress`/
`validation` by the time the board restarts, so a crash between reserving and releasing can never
leave the reserved budget permanently overstated.

`cardLaunch.js`'s `reconcileLaunchOutcome` releases the reservation (and attaches the realized
outcome, below) once `orchestrator.runCard(id)` settles, however it settles — completion, a
reviewer-fail-then-blocked run, or a rejected launch/resource-acquisition failure all release the
reservation they made. Under enforcement, a refused launch (an admission hold or an active overrun
stop) also releases the reservation it had provisionally written, rather than orphaning it.

## What gets reserved (spec §5 acceptance: retries + reviewer, ledger-aware, live)

`runner/launchAdvisory.js`'s `reservedExecutionCycleEstimate` folds the reviewer phase and a
bounded retry count into one reservation: `(implementer estimate + reviewer estimate) ×
effectiveMaxAttempts(task)` — `runOrchestrator.js`'s own exported retry-allowance helper, shared
by the auto-retry loop and the launch boundary, so a card's `max_attempts` override (1-20) is
reserved for exactly, not the fixed `MAX_AUTO_RETRY_ATTEMPTS` default. Usage already metered in
the T-A ledger for *this* execution id is subtracted before reserving (`usageLedger.js`'s
`executionTotal(...).knownCostUsd`), so a resumed/retried launch never double-counts spend it has
already made as still-unspent reservation.

**Other active reservations are counted at their REMAINING future cost, not their raw reserved
amount.** `sumActiveReservedRemainingCostUsd` subtracts what each active reservation's own
execution has already charged in the ledger before summing it into `reserved_unspent_cost` — an
unreadable ledger for any one of them makes the whole sum indeterminate (never a silent
under-count).

## The admission formula (spec §4) — `runner/admissionDecision.js`

Evaluated independently for `five_hour` and `seven_day`, in the same verified units, per window:

```
predicted_remaining_cost_upper_bound
    <= dial * max(0, observed_remaining_capacity
                     - reserved_unspent_cost
                     - expected_external_burn_allowance
                     - uncertainty_reserve)
```

- `observed_remaining_capacity` comes ONLY from a `measured` reading (T-0367's
  `readWindowUsage`/`readUsageTelemetry`, never `usageWindow.js`'s newest-event-wins reader). An
  `estimated` reading (an elapsed-reset `0`, or a status-only `allowed` event — see the 2026-09-12
  design note below), `stale`, or `unavailable` reading yields the explicit
  `no_measured_window_reading` hold, never a fabricated number.
- An estimate classified `indeterminate` or `large_hold_for_sizing`, or with a `null` value,
  yields `estimate_unknown` — never coerced to zero cost or unlimited capacity.
- **Units are never assumed to match.** T-0369's estimates are USD; window telemetry is a
  utilization fraction. Without a versioned conversion (`{usdPerUtilizationUnit, sampleCount,
  fitDate}`, derived from recorded evidence — no such fit exists yet), the comparison returns
  `units_not_comparable`. In practice this means **every real launch through this card hits that
  hold today** — the mechanism is built and tested, but nothing yet supplies the dollar-to-window
  conversion rate. Deriving and versioning that rate (so the formula can actually admit/refuse in
  window units) is future work, not this card's.
- A healthy reading in one window never masks an exhausted other: `evaluateAdmission` combines
  both windows and is only "admitted" when *every* window admits.

### 2026-09-12 design note (Codex review of #381)

An elapsed-reset `estimated` `0` and a status-only `allowed` event are both **policy stand-ins**,
not measurements — other consumers (manual sessions, other hosts) may have already spent the new
window. Both must read as `no_measured_window_reading`, never as verified headroom. Covered by
`admissionDecision.test.js`'s "evaluateWindowAdmission -- only a measured reading is verified
capacity" suite.

## Reserves (spec §6) — kept distinct, per window, in `loadAdmissionConfigFromEnv`

| Env var | Default | Meaning |
|---|---|---|
| `WIP_GATE_DIAL` | `1` | Overall multiplier on the admitted budget |
| `WIP_GATE_EXTERNAL_BURN_ALLOWANCE_FIVE_HOUR` / `_SEVEN_DAY` | `0.05` | Conservative floor set aside for manual/other-host consumers this mechanism can't see |
| `WIP_GATE_UNCERTAINTY_RESERVE_FIVE_HOUR` / `_SEVEN_DAY` | `0.05` | Separate margin for estimate uncertainty |

Every explicit override is logged (`wip-gate admission: explicit config override -- KEY=value`).
Manual sessions and other hosts can't be constrained directly — they are covered only by the
external burn allowance.

## Enforcement flag — `WIP_GATE_ENFORCEMENT_ENABLED` (default OFF)

- `admissionDecision.js`'s `admissionEnforcementEnabledFromEnv()`.
- **With the flag unset (the live board's configuration), `cardLaunch.js` never refuses or delays
  a launch.** The advisory pipeline still runs (bounded, failure-isolated) and still writes its
  reservation/record, but nothing inspects `admission` to gate the launch.
- **With the flag on, the shared decision at `launchCardRun` is authoritative for both callers.**
  `launchCardRun` inspects the `admission` its own `decide()` call recorded before calling
  `launch()`: an explicit hold on any window (`no_measured_window_reading`, `estimate_unknown`,
  `units_not_comparable`, `reserved_cost_unknown`, or an outright `admitted: false`) refuses the
  launch (`CardLaunchError`, 409) with a reason naming every non-admitting window, and releases
  the reservation the advisory pipeline had provisionally written. A missing `admission` (the
  advisory pipeline itself timed out or errored) is ALSO a hold — unknown capacity is never "not
  blocked". **Because no USD-to-utilization conversion has been derived yet (see "What this card
  deliberately does not do" below), every real launch's admission holds `units_not_comparable` —
  so turning this flag on today holds every launch. That is the intended fail-safe, not a bug**;
  it is also exactly why this card does not enable it on the live board.
- No poller-side check can admit what the shared decision holds: the poller's own
  `evaluateWindowAwareUsageGate` pre-check (below) may only be MORE conservative (skip a tick
  the shared decision would have allowed), and any `CardLaunchError` the shared decision raises
  from `launchFn` is already treated as a tick skip (`autoLaunchPoller.js`'s existing
  `err instanceof CardLaunchError` handling) — the poller was never a second, independent gate.
- The one OTHER place this flag currently changes behaviour: `autoLaunchPoller.js`'s window-aware
  usage comparison (below) replaces the legacy newest-event usage gate only when this flag is on.
- The flag still defaults OFF and is not enabled on the live board by this card.

## Advisory evidence collection (spec §10) — `launchAdvisory.js` + T-0369's `advisoryLogger.js`

Every launch through `launchCardRun` builds a bounded `decide()` (`launchAdvisory.js`'s
`buildLaunchDecide`, wrapped in `withBoundedDecide`) and runs it through T-0369's
`withAdvisoryLogging`, which structurally guarantees `launch()` always runs regardless of what
`decide()` does. `decide()` itself:

1. Gets the implementer-phase estimate via T-0369's `decideLaunchAdvisory` (own ledger history +
   current telemetry).
2. Gets the reviewer-phase prior via `estimateCost({type: "review", ...})`.
3. Builds the reserved-execution-cycle estimate (above).
4. Evaluates admission against every *other* launch's currently active reservations.
5. Reserves this launch's own slot (`reserveLaunchSlot`).
6. Persists the decision via T-0369's `recordAdvisoryDecision` — the prediction, its estimator
   version and fit identity, and each window's telemetry freshness classification.

**Bounded and failure-isolated (constraint 6).** `withBoundedDecide` (built on `boundedAwait.js`'s
`withTimeout`) races the whole pipeline against `DEFAULT_ADVISORY_TIMEOUT_MS` (8s) and always
resolves — never rejects, never hangs past that bound — regardless of a throwing or merely-slow
telemetry read, estimator, reservation write, or advisory-record write. This exists because
T-0369's own `withAdvisoryLogging` awaits `decide()` before calling `launch()`: it protects
against `decide()` *throwing*, but has no timeout of its own, so a slow (not throwing) `decide()`
would otherwise still delay the launch it's supposed to never affect. The same `withTimeout`
primitive also bounds the two other pre-launch awaits that sit ahead of `decide()` on the shared
path and aren't covered by it: the poller's `readUsageTelemetry` read, and `launchCardRun`'s own
`ensureExecutionId` read.

`withBoundedDecide` also passes `decideFn` a cancellation token that flips true the instant it
commits to a timeout/error fallback, and persists that fallback itself (via
`recordAdvisoryDecisionFn`) before resolving — so a late-settling `decide()` can never write a
reservation lease nothing will release, or leave a second, outcome-less advisory record behind
once the run it was for has already settled.

Once `orchestrator.runCard(id)` settles, `cardLaunch.js`'s `reconcileLaunchOutcome` attaches the
realized outcome via T-0369's `recordAdvisoryOutcome` — `exact` only when `runCard` ended in a
successful terminal state AND every contributing ledger entry for this execution is itself a
successful, complete, known-cost entry (`usageLedger.js`'s `executionEndedSuccessfully`); a
terminal quota stop, a reviewer FAIL that lands the card on `blocked`, and a cancellation all
report the known subtotal as a LOWER BOUND instead — `runCard` merely resolving (or rejecting) is
not itself proof of success. `measureRecordedCoverage` accumulates this real predicted-vs-actual
evidence over time.

## Window-aware evidence in the poller (launch-time contracts, 2026-09-14)

`autoLaunchPoller.js`'s legacy usage gate (`usageWindow.js`'s `readUsageSnapshot`) reads the
newest `rate_limit_event` of *any* window, so it cannot distinguish 5-hour pressure from weekly
pressure. `evaluateWindowAwareUsageGate` reads both windows independently (T-0367) and is logged
side by side with the legacy decision on every tick, regardless of configuration — so the
difference is visible from evidence before anyone considers turning `WIP_GATE_ENFORCEMENT_ENABLED`
on. With the default configuration the legacy gate keeps deciding launches exactly as before;
under the flag, the window-aware decision replaces it entirely (an unmeasured window is unknown,
never a fabricated block).

## Overrun response (spec §11) — `runner/overrunPolicy.js`

Overruns are recorded through the same coverage machinery described above (T-0369's
`measureRecordedCoverage` reads every recorded prediction against its attached outcome).
`evaluateOverrunPolicy` aggregates that evidence across every estimator/fit group into one
exceeded-fraction and flags an overrun once there is enough evidence to trust it
(`DEFAULT_OVERRUN_MIN_EVALUATED`, default 3) and the exceeded fraction reaches
`DEFAULT_OVERRUN_EXCEEDED_FRACTION` (default 0.5) — a couple of misses on a freshly-deployed
estimator is not treated as a systemic overrun, and an unreadable coverage read fails OPEN (no
overrun flagged) rather than escalate on missing evidence.

**Under enforcement, an active overrun stop refuses a brand-new admission** at `launchCardRun`
(after the admission-hold check above), releasing the reservation it had provisionally written.
**Bounded continuation:** `isBoundedContinuation` still allows a card that already has ledger
history for THIS execution (a retry within an already-admitted cycle) to proceed even during an
active overrun stop — refusing an in-flight card's own retry would abandon already-spent work
rather than bound it. Both are implemented in production code and tested behind the flag; neither
is deferred to a later card.

## What this card deliberately does not do

- Does not derive or version a USD-to-window-utilization conversion rate — every real admission
  decision holds `units_not_comparable` until a later card builds that from recorded evidence
  (which is also why turning enforcement on today holds every launch — see "Enforcement flag").
- Does not change the live board's configuration or systemd drop-ins, and does not enable
  `WIP_GATE_ENFORCEMENT_ENABLED` anywhere live.
- Does not weaken or replace `usageLimitDetector.js`'s existing actual-rejection checks.
