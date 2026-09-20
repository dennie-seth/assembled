# WIP gate T-E: shared GPU lease

**T-0371 ("T-E" of the WIP-gate set), depends on T-0370 ("T-D", the launch-boundary
reservation/admission this card hooks into).** Advisory/off by default, exactly like T-0370: with
the default configuration this card changes no launch behaviour. Companion docs:
`docs/gpu-submission-audit.md` (every path that submits GPU work, and which of them this lease
can actually govern) and `docs/wip-gate-admission.md` (T-0370's token/window admission, a
different currency from the one this card tracks).

## Why GPU needs its own mechanism, not a bigger token budget

T-0370's `launchReservation.js` tracks a divisible USD cost pool: many launches can each reserve
their own slice of a shared budget, summed additively. A GPU is not divisible that way -- this
repo has exactly one physical GPU box today (`docs/gpu-submission-audit.md`), and two GPU
workloads running on it at once contend for the same VRAM/compute rather than splitting a budget.
The right model is mutual exclusion (one owner at a time), not a bigger number in the same pool --
which is also why the acceptance criteria call it out explicitly as its own currency, never summed
with token cost.

## The lease -- `tools/board/src/runner/gpuLease.js`

One lease file per constrained GPU/ComfyUI server (`GPU_SERVER_ID`, currently a single
`"comfyui-primary"` -- see `docs/gpu-submission-audit.md`'s "the constrained resource is the
physical GPU box, not any one network port"), keyed to that server's fixed path -- not one file
per launch, unlike `launchReservation.js`'s per-`(cardId, executionId, invocationId)` files, since
exclusivity here means "at most one file for this server can exist at all", not "sum whatever
files exist".

- `acquireGpuLease` writes a temp file to completion, then links it into the server's fixed path
  (`fs.link`, mirroring `reserveLaunchSlot`): the final path never exists until the content is
  complete, and a second acquire while one is already held gets `EEXIST` -- which
  `acquireGpuLease` turns into a `GpuLeaseHeldError` naming the current holder
  `(cardId/executionId/invocationId, owner)`. Re-acquiring the SAME key while already held is
  refused identically -- a lease is single-use until explicitly released, never idempotent on the
  acquiring side.
- `releaseGpuLease` unlinks the lease file outright (not a `released: true` marker like
  `launchReservation.js` -- there is no need to keep a released GPU lease around for audit; the
  file's mere existence *is* the only fact this mechanism needs). It only releases a lease that
  matches the caller's own identity -- a stale or superseded caller can never clear someone else's
  active lease -- and is idempotent: releasing an already-free server, or one held by someone
  else, returns `null` rather than throwing.
- `readGpuLease` returns the current holder, or `null` when the server is free.

## Wired into the shared launch boundary -- `runner/cardLaunch.js`

`launchCardRun` acquires the GPU lease for `assets`/`audio` cards only
(`resolveCostEstimatorType(task) === GPU_COST_ESTIMATOR_TYPE`, the same "asset-GPU" classification
T-0370's cost estimator already uses -- one source of truth for which agents touch the GPU,
exported from `launchAdvisory.js` and shared by both modules rather than duplicated), via a single
`acquireGpuLeaseGate()` step called immediately before every one of the three places
`launchCardRun` hands off to `orchestrator.runCard(id)`: the advisory pipeline's own success path
(right after admission, as before), the manual-override-under-enforcement fallback, and the
enforcement-off fallback. A single atomic filesystem link is already sufficient for mutual
exclusion at server granularity, the same reasoning `reserveLaunchSlot` already relies on at
per-launch-key granularity, so no in-process capacity lock is needed either.

**FIX ROUND 1 (Chat round-2 review of #407, finding 1 -- P1):** an earlier revision acquired the
lease only inside T-0370's advisory-pipeline `launch()` callback -- a path that pipeline
deliberately never reaches on a setup error (a throwing `buildLaunchDecideFn`), with token
enforcement off, or on a manual override even when enforcement is on (all correct fail-open
behaviour for TOKEN capacity, a judgement call, but wrong for GPU exclusivity, a hardware fact).
Chat reproduced this live through `launchCardRun`: a real lease held by another card, GPU leasing
on, token enforcement off, `buildLaunchDecideFn` throwing -- the second card's worker launched
anyway. `acquireGpuLeaseGate()` closes this: it is called on every route out of `launchCardRun`
that reaches `orchestrator.runCard`, independent of whether the advisory/token pipeline itself
succeeded, failed open, or was bypassed by a manual override.

- **Held, or any other acquisition failure -> refused.** A `GpuLeaseHeldError`, or any other
  acquisition error (a filesystem/I/O error, a permission error, a malformed lease file),
  releases this launch's own (already-written) token reservation -- never leaving it dangling for
  a launch that never actually started -- and raises a `CardLaunchError` (409, `gpuLeaseHold:
  true`) naming the current holder or the error.
- **Never bypassable by `trigger`.** Unlike T-0379's capacity-fit limit, a manual (operator)
  launch does NOT override a held GPU lease -- mutual exclusion on one physical GPU is a hardware
  fact, not a policy judgement call a human should be able to override through the Run button. (A
  human who genuinely needs to run two GPU things at once already can, exactly as today, by not
  using the board for one of them -- see `docs/gpu-submission-audit.md`'s uncontrolled paths; this
  card does not change that.)
- **Independent of `WIP_GATE_ENFORCEMENT_ENABLED`.** The GPU lease has its own flag
  (`GPU_LEASE_ENABLED`, below) and its own acquire/refuse logic, gated separately from T-0370's
  token-admission enforcement switch -- GPU capacity is tracked as its own currency and can be
  turned on (later, by a human) independently of token enforcement, never folded into it.
- **Released on completion, failure, and cancel.** `reconcileLaunchOutcome` (already the single
  place T-0370 releases the token reservation once `orchestrator.runCard(id)` settles, however it
  settles) unconditionally also calls `releaseGpuLeaseFn` -- a safe no-op when no lease was ever
  acquired for this identity (an unmatched identity or an already-free server), so this one call
  site correctly covers the non-GPU-card case, the flag-off case, and the real release case alike
  without a separate conditional.

## Crash / board-restart reconciliation -- `reconcileGpuLeasesOnStartup`

Wired into `boardServer.js`'s bootstrap immediately beside T-0370's
`reconcileReservationsOnStartup`, against the same task store, using the identical liveness rule
(`in-progress`/`validation`). This is what makes GPU ownership and the token reservation "recover
coherently together" (acceptance): a card that crashed mid-run loses both stale records in the
same startup pass, judged against the same live/dead determination, and a card genuinely still
running (survived the restart with the same pid, per `orphanReaper.js`) keeps both. Tolerant of an
unreadable/malformed lease file or an unlistable `.gpu-leases` directory exactly like the token
reservation's own startup follow-up -- logged and left untouched, never the reason a board process
fails to start.

## Default configuration -- `GPU_LEASE_ENABLED` (default OFF)

`gpuLeaseEnabledFromEnv()` (`gpuLease.js`), the same `1`/`true`/`on`/`yes` convention as
`WIP_GATE_ENFORCEMENT_ENABLED`. With it unset (the live board's configuration today), `cardLaunch.js`
never acquires or checks a GPU lease at all -- no launch that happens today is refused by this
card. Turning it on is left to a separate, later decision (@DennieSeth's call), exactly like
T-0370's own enforcement flag; this card does not enable it on the live board or touch any systemd
drop-in.

## What this card deliberately does not do

- Does not attempt to intercept GPU work reaching ComfyUI/ACE-Step/training outside a
  board-launched `assets`/`audio` card's own implementer run -- see
  `docs/gpu-submission-audit.md`'s uncontrolled paths (a script or the ComfyUI UI used directly).
  A board-owned lease can only ever govern what the board itself launches.
- Does not weaken or replace T-0370's token reservation/admission machinery, or
  `usageLimitDetector.js`'s existing actual-rejection checks -- GPU capacity is tracked entirely
  separately, never summed into or substituted for the USD reservation pool.
- Does not change the live board's configuration or systemd drop-ins, and does not enable
  `GPU_LEASE_ENABLED` anywhere live.
