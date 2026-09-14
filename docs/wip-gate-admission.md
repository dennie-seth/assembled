# WIP gate T-D: shared launch-boundary reservation and per-window admission

**T-0370 ("T-D" of the WIP-gate set).** Advisory-by-default: this card wires the admission
machinery into the shared launch boundary and starts collecting predicted-vs-actual evidence, but
changes no launch behaviour today. Depends on T-0367 ("T-A", telemetry + usage ledger,
`docs/usage-telemetry.md`) and T-0369 ("T-C", cost estimator + advisory logger). The enforcement
flip is a separate, later, explicitly-gated decision — not made by this card, and not enabled on
the live board by this card.

## The shared launch boundary

`launchCardRun` (`tools/board/src/runner/cardLaunch.js`) is the one path both the Run button
(`POST /api/tasks/:id/run`, `server/httpApi.js`) and the auto-launch poller
(`runner/autoLaunchPoller.js`) launch a card through. Every guard the Run button relies on lives
there — this card adds the admission/advisory/reservation machinery at the same point, right
before `orchestrator.runCard(id)` is actually called, so both launchers get it for free.

## Reservation ledger (spec §5) — `runner/launchReservation.js`

`reserveLaunchSlot` atomically writes one lease file per launch, keyed by
`(cardId, executionId, invocationId)` — the same identity triple `usageLedger.js` uses — via
exclusive create (`wx`). Two different launches can never collide on the same lease file (each
gets its own uniquely-keyed one), so `listActiveReservations`'s sum is always the sum of every
currently-unreleased lease, with no read-then-write race between concurrent launches. Reserving
the *identical* key twice is refused (`DuplicateReservationError`) — that would double-book one
launch's own budget against itself.

`releaseReservation` marks a lease released (idempotent) with the outcome it ended on.
`reconcileReservationsOnStartup` — wired into `boardServer.js`'s bootstrap, right after
`orphanReaper.reapOnStartup()` — releases any lease whose card is no longer `in-progress`/
`validation` by the time the board restarts, so a crash between reserving and releasing can never
leave the reserved budget permanently overstated.

`cardLaunch.js`'s `reconcileLaunchOutcome` releases the reservation (and attaches the realized
outcome, below) once `orchestrator.runCard(id)` settles, however it settles — completion, a
reviewer-fail-then-blocked run, or a rejected launch/resource-acquisition failure all release the
reservation they made.

## What gets reserved (spec §5 acceptance: retries + reviewer, ledger-aware)

`runner/launchAdvisory.js`'s `reservedExecutionCycleEstimate` folds the reviewer phase and a
bounded retry count into one reservation: `(implementer estimate + reviewer estimate) ×
MAX_AUTO_RETRY_ATTEMPTS`. The reviewer estimate always comes from `costEstimator.js`'s registered
`"review"` type prior — there is no per-card reviewer-phase history to fit against at launch time.
Usage already metered in the T-A ledger for *this* execution id is subtracted before reserving
(`usageLedger.js`'s `executionTotal(...).knownCostUsd`), so a resumed/retried launch never
double-counts spend it has already made as still-unspent reservation.

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
- **`cardLaunch.js` never refuses or delays a launch, regardless of this flag.** The formula and
  reservation ledger exist to collect evidence and be ready for a later, explicit enforcement
  card — this one ships the mechanism, not the flip.
- The one place this flag currently changes behaviour: `autoLaunchPoller.js`'s window-aware usage
  comparison (below) replaces the legacy newest-event usage gate only when this flag is on. It is
  not enabled on the live board by this card.

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

**Bounded and failure-isolated (constraint 6).** `withBoundedDecide` races the whole pipeline
against `DEFAULT_ADVISORY_TIMEOUT_MS` (8s) and always resolves — never rejects, never hangs past
that bound — regardless of a throwing or merely-slow telemetry read, estimator, reservation
write, or advisory-record write. This exists because T-0369's own `withAdvisoryLogging` awaits
`decide()` before calling `launch()`: it protects against `decide()` *throwing*, but has no
timeout of its own, so a slow (not throwing) `decide()` would otherwise still delay the launch
it's supposed to never affect.

Once `orchestrator.runCard(id)` settles, `cardLaunch.js`'s `reconcileLaunchOutcome` attaches the
realized outcome via T-0369's `recordAdvisoryOutcome` — exact when the ledger has a known total
cost for this execution, a lower bound otherwise — so `measureRecordedCoverage` accumulates real
predicted-vs-actual evidence over time.

## Window-aware evidence in the poller (launch-time contracts, 2026-09-14)

`autoLaunchPoller.js`'s legacy usage gate (`usageWindow.js`'s `readUsageSnapshot`) reads the
newest `rate_limit_event` of *any* window, so it cannot distinguish 5-hour pressure from weekly
pressure. `evaluateWindowAwareUsageGate` reads both windows independently (T-0367) and is logged
side by side with the legacy decision on every tick, regardless of configuration — so the
difference is visible from evidence before anyone considers turning `WIP_GATE_ENFORCEMENT_ENABLED`
on. With the default configuration the legacy gate keeps deciding launches exactly as before;
under the flag, the window-aware decision replaces it entirely (an unmeasured window is unknown,
never a fabricated block).

## Overrun response (spec §11)

Overruns are recorded through the same coverage machinery described above (T-0369's
`measureRecordedCoverage` reads every recorded prediction against its attached outcome). The
"stop admitting new work" / bounded continuation-retry half of spec §11 is the enforcement flip
itself — out of scope for this card per the launch-time-contracts addendum, which governs: this
card collects the evidence and builds the formula/flag the later enforcement card will consume,
and does not add refusal behaviour to `cardLaunch.js`.

## What this card deliberately does not do

- Does not derive or version a USD-to-window-utilization conversion rate — every real admission
  decision holds `units_not_comparable` until a later card builds that from recorded evidence.
- Does not change the live board's configuration or systemd drop-ins, and does not enable
  `WIP_GATE_ENFORCEMENT_ENABLED` anywhere live.
- Does not weaken or replace `usageLimitDetector.js`'s existing actual-rejection checks.
