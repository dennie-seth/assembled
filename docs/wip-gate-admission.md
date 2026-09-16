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

## Fix round 2 (2026-09-15, Codex round-2 review of #387)

Codex re-reviewed the fix-round branch and found five further gaps, all fixed on this branch;
verified-good from round 1 (the effective retry allowance, lower-bound stopped/failed outcomes, the
serialization lock through the real path, startup recovery, and the bounded identity/poller waits)
is unchanged:

1. **Bound the fallback's own persistence.** `withBoundedDecide`'s timeout/error `fallback`
   callback awaits `onFallback` (the fallback record's own durable write) with its own
   `withTimeout` (`fallbackTimeoutMs`, defaults to the same bound as `decide()` itself) — a hung or
   throwing persistence write can no longer keep the whole bounded pipeline pending indefinitely.
2. **Late writes reconcile themselves.** `buildLaunchDecide` re-checks its cancellation token after
   `reserveLaunchSlotFn` resolves and self-releases a lease that landed only after this `decide()`
   was already superseded. `advisoryLogger.js`'s `recordAdvisoryDecision` now writes via exclusive
   create (`fs.link`, mirroring `reserveLaunchSlot`) instead of an unconditional overwrite: the
   FIRST write to actually land for a given launch identity wins, so a late happy-path write can
   never clobber the timeout/error fallback record or an outcome already attached to it.
3. **Prior spend subtracted exactly once — the documented convention.** A lease stores the
   REMAINING cost (`reservedCostUsd`, already net of what this execution had charged when the
   lease was written) *plus* the `chargedAtReservationUsd` baseline it was computed against.
   `remainingReservedCostUsd(reservation, totalSpentUsd)` subtracts only `max(0, totalSpentUsd -
   chargedAtReservationUsd)` — spend charged AFTER the baseline — never `totalSpentUsd` outright,
   which would subtract the same prior spend a second time. The candidate's own admission input
   (`evaluateAdmissionFn`'s `estimate`) uses this same future-cost `reservedCostUsd`, not the full,
   gross `reservedExecutionCycleEstimate`.
4. **Enforcement never falls through to a launch.** `buildLaunchDecide`'s returned `admission` now
   carries `reservationPublished` (`false` on a failed or duplicate reserve), and
   `cardLaunch.js`'s `describeAdmissionRefusal` refuses on that alone regardless of the per-window
   verdict. `cardLaunch.js` also bounds the `decide()` call itself (on top of `buildLaunchDecide`'s
   own internal bound), and its catch around building/running the decision refuses under
   enforcement — releasing any lease already created — instead of falling through to the
   unconditional launch at the bottom of `launchCardRun`.
5. **Unknown lease costs and shapes are never zero.** `remainingReservedCostUsd` and
   `sumActiveReservedCostUsd` return `null` — never a substituted `0` — the instant any active
   lease's own `reservedCostUsd` isn't a finite, non-negative number (an unknown-cost launch counts
   as unknown, not free, to every later admission); `buildLaunchDecide` publishes `reservedCostUsd:
   null` rather than `0` when its own estimate is itself unknown. `listActiveReservations` now
   validates every parsed lease's shape (a plain object, string `cardId`/`executionId`/
   `invocationId` matching the file it was read from, boolean `released`) — a JSON `null`, an
   array, a bare scalar, a missing/mismatched identity, or a non-boolean `released` raises
   `ReservationPoolReadError` exactly like an unparseable file. Startup's separate tolerant reader
   is unaffected — it already logs and skips per-file, whatever the failure.

## Fix round 3 (2026-09-16, Codex round-3 review of #387)

Codex re-reviewed the round-2 branch and confirmed every round-2 fix (bounded fallback
persistence, late lease writes releasing themselves, exclusive-create decisions, the
charged-usage baseline, enforcement refusal, lease shape validation) — the ONE remaining gap:

`cardLaunch.js` wraps the whole `decide()` call in its own 8s bound (`withTimeout`), on top of
`buildLaunchDecide`'s own separate 8s bound around `innerDecide`/its timeout fallback. The OUTER
bound can fire and let `launch()` (and so `orchestrator.runCard`) proceed while the INNER
fallback's own persistence write is still in flight — `withBoundedDecide`'s `onFallback` is bounded
against hanging forever (round 2 finding 1), but nothing stops it finishing strictly *after* the
run it was for has already completed and been reconciled. When that happens,
`reconcileLaunchOutcome`'s `recordAdvisoryOutcome` call finds no decision record yet (ENOENT),
and the outcome used to be logged as a failure and discarded — the fallback record then publishes
moments later with `outcome: null`, and nothing left to attach it.

**Fix: retain, don't discard.** `advisoryLogger.js`'s `recordAdvisoryOutcome` now throws a
distinguishable `AdvisoryDecisionMissingError` (not a generic `Error`) when no decision exists yet.
`cardLaunch.js`'s `reconcileLaunchOutcome` catches specifically that and calls the new
`retainOutcomeUntilDecisionRecorded`, which writes a durable marker keyed to the launch identity
(`pendingOutcomePath` — a `.outcome-pending.json` suffix, deliberately different from
`.advisory.json` so `measureRecordedCoverage`'s glob never mistakes a marker for a scoreable
decision) and immediately re-checks whether the decision has landed concurrently. `recordAdvisoryDecision`
performs the identical re-check right after establishing its own record — whether that's the
normal happy-path write or the timeout fallback's write, either one now looks for a pending marker
and attaches it. Both call sites share one `consumePendingOutcome` helper whose **unlink-as-ownership-token**
makes the coordination race-safe: only the caller that actually succeeds at deleting the marker file
attaches the outcome, so a marker read/attach racing between `retainOutcomeUntilDecisionRecorded`'s
own re-check and `recordAdvisoryDecision`'s converges on exactly one attach, regardless of which
order the two land in. A decision record that already carries a non-null outcome is never
overwritten — the marker is still cleared in that case (it's served its purpose, or was always
stray), so it never outlives its use. Coordination is independent of any timeout — it holds
whichever write lands first, not just the specific 8s/8s race Codex reproduced.

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
reserved for exactly, not the fixed `MAX_AUTO_RETRY_ATTEMPTS` default.

**Cost convention (fix round 2, finding 3) — the lease stores the REMAINING cost plus the baseline
it was computed against; a reader never subtracts prior spend twice.** `buildLaunchDecide` nets the
full reserved-execution-cycle estimate against what THIS execution has already charged in the T-A
ledger for this launch identity (`usageLedger.js`'s `executionTotal(...).knownCostUsd`) and writes
the result as `reservedCostUsd`, alongside that same charged amount as `chargedAtReservationUsd` —
`launchReservation.js`'s `reserveLaunchSlot` persists both fields. A later reader
(`remainingReservedCostUsd(reservation, totalSpentUsd)`) computes `max(0, reservedCostUsd -
max(0, totalSpentUsd - chargedAtReservationUsd))`: only spend charged AFTER the baseline reduces
the lease further, so the prior spend already netted out at write time is never subtracted a
second time. The candidate's own admission input follows the identical convention — it's the same
future-cost `reservedCostUsd`, never the full, gross `reservedExecutionCycleEstimate`. An unknown
reserved-cycle estimate (an indeterminate/hold-for-sizing implementer or reviewer estimate)
publishes `reservedCostUsd: null` — an explicit unknown, never a fabricated `0` — so it still counts
as unknown, not free, capacity to every later admission.

**Other active reservations are counted at their REMAINING future cost, not their raw reserved
amount.** `sumActiveReservedRemainingCostUsd` calls `remainingReservedCostUsd` per reservation
before summing into `reserved_unspent_cost` — an unreadable ledger for any one of them, OR any one
reservation's own `reservedCostUsd` being unknown, makes the WHOLE sum indeterminate (`null`),
never a silent under-count or a substituted zero. `sumActiveReservedCostUsd` (the simple raw sum)
carries the same "unknown never becomes zero" rule.

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
  blocked". A reservation that failed to publish (`admission.reservationPublished === false`,
  fix round 2 finding 4) refuses on that alone, regardless of what the per-window formula
  concluded — this launch's own capacity was never actually reserved. **Because no
  USD-to-utilization conversion has been derived yet (see "What this card deliberately does not
  do" below), every real launch's admission holds `units_not_comparable` — so turning this flag on
  today holds every launch. That is the intended fail-safe, not a bug**; it is also exactly why
  this card does not enable it on the live board.
- **The boundary never falls through to an unconditional launch under the flag (fix round 2 finding
  4).** `decide()` is bounded at `cardLaunch.js` itself (on top of `buildLaunchDecide`'s own
  internal bound), so a throwing or never-settling decide resolves to `advisory: null` — an
  explicit hold — rather than hanging or silently succeeding. A failure building or running the
  decision at all (e.g. a throwing `buildLaunchDecideFn`, never reaching `decide()`/`launch()`)
  is itself a refusal under the flag, releasing any lease this launch had already created, instead
  of reaching the last-resort unconditional launch that only ever runs with the flag off.
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
`recordAdvisoryDecisionFn`) before resolving — itself bounded by its own `withTimeout`
(`fallbackTimeoutMs`, fix round 2 finding 1), so a hung or throwing persistence write can't keep
the whole pipeline pending past a finite deadline either. `recordAdvisoryDecision` writes via
exclusive create (fix round 2 finding 2), so whichever write for a given launch identity actually
lands on disk FIRST wins; a late-settling `decide()`'s own happy-path write can never write a
reservation lease nothing will release (`buildLaunchDecide` self-releases a lease that lands after
cancellation), or clobber the fallback record — or an outcome already attached to it — once the run
it was for has already settled.

Once `orchestrator.runCard(id)` settles, `cardLaunch.js`'s `reconcileLaunchOutcome` attaches the
realized outcome via T-0369's `recordAdvisoryOutcome` — `exact` only when `runCard` ended in a
successful terminal state AND every contributing ledger entry for this execution is itself a
successful, complete, known-cost entry (`usageLedger.js`'s `executionEndedSuccessfully`); a
terminal quota stop, a reviewer FAIL that lands the card on `blocked`, and a cancellation all
report the known subtotal as a LOWER BOUND instead — `runCard` merely resolving (or rejecting) is
not itself proof of success. If no decision record exists yet for this launch identity (fix round
3 — the outer bound can beat the inner fallback's own persistence), the outcome is retained
durably rather than discarded and attaches to whichever decision eventually publishes — see "Fix
round 3" above. `measureRecordedCoverage` accumulates this real predicted-vs-actual evidence over
time.

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
