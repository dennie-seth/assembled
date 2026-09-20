import { randomUUID } from "node:crypto";
import { assertCanMoveToInProgress, UnmetDependencyError, DependencyCycleError } from "../lib/dependencyGuard.js";
import { assertRoundCapClear, RoundCapExceededError } from "../lib/roundCap.js";
import { appendNote, effectiveMaxAttempts } from "./runOrchestrator.js";
import { ensureExecutionId, executionTotal, executionEndedSuccessfully, listCardUsageEntries } from "./usageLedger.js";
import {
  withAdvisoryLogging,
  recordAdvisoryOutcome,
  retainOutcomeUntilDecisionRecorded,
  AdvisoryDecisionMissingError,
  recordManualOverride
} from "./advisoryLogger.js";
import { buildLaunchDecide, resolveCostEstimatorType } from "./launchAdvisory.js";
import { loadAdmissionConfigFromEnv, admissionEnforcementEnabledFromEnv, HOLD_REASON } from "./admissionDecision.js";
import { detectOversizedCard, drainModeEnabledFromEnv } from "./drainMode.js";
import { releaseReservation } from "./launchReservation.js";
import { withTimeout, DEFAULT_BOUND_MS } from "./boundedAwait.js";
import { evaluateOverrunPolicy, isBoundedContinuation } from "./overrunPolicy.js";

/** The two callers of the shared launch boundary (T-0379): the auto-launch poller, and every operator-initiated launch (the Run button, and any other manual launch). */
export const LAUNCH_TRIGGERS = Object.freeze({ AUTO: "auto", MANUAL: "manual" });

/**
 * T-0370 fix round 2 finding 4/5: a reservation that failed to publish means this launch's own
 * capacity was never actually recorded against the shared pool, regardless of what the per-window
 * formula concluded -- admitting it would silently understate what every OTHER launch's own
 * admission check sees. This is a ledger-integrity guarantee, not a capacity/fit policy call, so
 * (T-0379) it is never bypassable by `trigger` -- manual override only ever bypasses
 * `capacityFitRefusal` below.
 */
function reservationIntegrityRefusal(admission) {
  if (admission && admission.reservationPublished === false) {
    return "reservation failed to publish -- capacity not actually reserved for this launch";
  }
  return null;
}

/**
 * T-0379: names why the shared admission decision holds a launch on capacity/fit grounds alone, or
 * `null` when it doesn't. `admission` missing entirely (the advisory pipeline itself timed
 * out/errored, per `launchAdvisory.js`'s fallback) is itself a hold -- unknown capacity is never
 * treated as "not blocked" (same rule as T-0370's original `describeAdmissionRefusal`, which this
 * replaces). `admission.admitted === true` requires EVERY window to have admitted (see
 * `admissionDecision.js`'s `evaluateAdmission`); anything else -- an explicit `false`, or the
 * aggregate `null` a per-window hold reason produces -- refuses, naming each non-admitting window's
 * own reason. This is the ONE refusal a manual (operator-initiated) launch is allowed to bypass
 * (acceptance: "Manual override ... bypass the auto-fit limit -- including the unknown-estimate and
 * unmeasured-window holds"); `reservationIntegrityRefusal` above is deliberately NOT part of this
 * function so it can never be bypassed by `trigger` alone.
 */
function capacityFitRefusal(admission) {
  if (!admission) return "advisory decision unavailable (timeout/error) -- unknown capacity";
  if (admission.admitted === true) return null;
  const reasons = Object.entries(admission.windows ?? {})
    .filter(([, decision]) => decision.admitted !== true)
    .map(([windowKind, decision]) => {
      const holdReason = decision.holdReason ?? "insufficient_capacity";
      const neverFits =
        holdReason === HOLD_REASON.OVERSIZED_ESTIMATE_NEVER_FITS
          ? " -- never fits this window even at full headroom; launch manually or split the card"
          : "";
      return `${windowKind}: ${holdReason}${neverFits}`;
    });
  return reasons.length > 0 ? reasons.join("; ") : "insufficient capacity";
}

/**
 * WIP gate T-D (spec §5/§10, launch-time contracts 2026-09-14): attaches the realized outcome
 * to the advisory decision `launchCardRun` recorded at launch time, and releases that launch's
 * reservation -- called once `orchestrator.runCard(id)` settles, however it settles (success,
 * reviewer-fail-then-blocked, crash-caught-and-rethrown, ...). `status` is carried on the
 * reservation's own `outcome` field for a human reading the ledger; the SCORED outcome
 * (`recordAdvisoryOutcome`, which `measureRecordedCoverage` later reads) is always derived from
 * the usage ledger's own recorded cost for this execution, never from `status` itself -- a
 * "failed" launch can still have a known, exact cost (e.g. a clean reviewer FAIL) just as a
 * "completed" one can have only a lower bound (e.g. an unread result event).
 *
 * T-0370 fix round (Codex review, finding 4): `costKind: "exact"` requires MORE than
 * `executionTotal(...).costUsd` merely being non-null -- `executionEndedSuccessfully` also
 * requires every contributing ledger entry to be a successful, complete entry
 * (`usageLedger.js`'s own `_recordUsage` classification), since `runCard` resolving (or even
 * rejecting) is not itself proof the run succeeded: a terminal quota stop, a reviewer FAIL that
 * lands the card on `blocked`, and a cancellation all still resolve/settle the same promise chain
 * while carrying a real, known subtotal that must be reported as a LOWER BOUND, not an exact
 * actual (the "stopped-work" defect T-0369 already fixed on the estimator side of this).
 *
 * Every step is best-effort: a failure here must never surface past this function, since by the
 * time it runs the run it describes is already over and there is nothing left to refuse.
 */
export async function reconcileLaunchOutcome({
  runsDir,
  cardId,
  executionId,
  invocationId,
  status,
  errorMessage = null,
  logger = console,
  listCardUsageEntriesFn = listCardUsageEntries,
  recordAdvisoryOutcomeFn = recordAdvisoryOutcome,
  retainOutcomeUntilDecisionRecordedFn = retainOutcomeUntilDecisionRecorded,
  releaseReservationFn = releaseReservation
}) {
  let outcome;
  try {
    const entries = await listCardUsageEntriesFn({ runsDir, cardId });
    const total = executionTotal(entries, executionId);
    outcome = executionEndedSuccessfully(entries, executionId)
      ? { costKind: "exact", actualCostUsd: total.costUsd }
      : { costKind: "lower_bound", actualCostUsd: total.knownCostUsd };
  } catch {
    outcome = { costKind: "lower_bound", actualCostUsd: 0 };
  }
  try {
    await recordAdvisoryOutcomeFn({ runsDir, cardId, executionId, invocationId, outcome });
  } catch (err) {
    if (err instanceof AdvisoryDecisionMissingError) {
      // T-0370 round 3: the outer launch timeout can beat buildLaunchDecide's own (separately
      // bounded) fallback persistence -- retain the outcome durably rather than discard it, so
      // whichever decision record eventually publishes (the normal write or the fallback) still
      // gets it attached.
      try {
        await retainOutcomeUntilDecisionRecordedFn({ runsDir, cardId, executionId, invocationId, outcome, logger });
      } catch (err2) {
        logger.error(`Agent Runner: failed to retain outcome pending a decision record for ${cardId}:`, err2.message);
      }
    } else {
      logger.error(`Agent Runner: failed to record advisory outcome for ${cardId}:`, err.message);
    }
  }
  try {
    await releaseReservationFn({ runsDir, cardId, executionId, invocationId, outcome: { status, errorMessage } });
  } catch (err) {
    logger.error(`Agent Runner: failed to release launch reservation for ${cardId}:`, err.message);
  }
}

/** The statuses the board's Run/Re-run button accepts. */
export const RUNNABLE_STATUSES = new Set(["ready", "review", "blocked"]);

/**
 * A refused launch. `statusCode` is the HTTP status `POST /api/tasks/:id/run` returns for this
 * refusal, carried on the error so the API layer maps it straight across instead of re-deriving
 * it -- and so non-HTTP callers (the auto-launch poller) get the same taxonomy without inventing
 * their own.
 */
export class CardLaunchError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "CardLaunchError";
    this.statusCode = statusCode;
  }
}

/**
 * The one guarded path a card run starts through, extracted from `httpApi.js`'s `handleRunTask`
 * so the HTTP endpoint and the in-process auto-launch poller are literally the same code rather
 * than two implementations that have to be kept in agreement. Every guard the Run button relies
 * on lives here: runnable status, the non-executable `dispatch` sentinel, the already-running
 * check (same-card, span-level -- fix-plan item #6), and `assertCanMoveToInProgress`
 * (docs/board-invariants.md RUN-3 / LC-5 -- a run moves
 * the card to in-progress the same way a manual PATCH does, so it must clear the same
 * dependency/cycle guard). The acceptance/capability preflights run inside `runCard` itself.
 *
 * Fire-and-forget by design: a run (implementer + reviewer) takes minutes, and callers follow
 * progress over the board WS, not this call. A failure inside the run is persisted onto the card
 * as `blocked` + a "Run Failed" note and broadcast, exactly as before -- and a failure to persist
 * *that* is logged and swallowed, since there is nothing left to report it to.
 */
export async function launchCardRun({
  orchestrator,
  id,
  logger = console,
  // T-0379: which of the two callers of this shared boundary this launch is. Defaults to the
  // strict `AUTO` behaviour -- fail-safe by construction, so a caller that forgets to opt into
  // `MANUAL` gets the auto-launch poller's own capacity-fit limit, never an accidental bypass.
  // Only the Run button (and any other deliberate, operator-initiated launch) should ever pass
  // `LAUNCH_TRIGGERS.MANUAL`.
  trigger = LAUNCH_TRIGGERS.AUTO,
  ensureExecutionIdFn = ensureExecutionId,
  randomUUIDFn = randomUUID,
  buildLaunchDecideFn = buildLaunchDecide,
  withAdvisoryLoggingFn = withAdvisoryLogging,
  loadAdmissionConfigFromEnvFn = loadAdmissionConfigFromEnv,
  reconcileLaunchOutcomeFn = reconcileLaunchOutcome,
  enforcementEnabledFn = admissionEnforcementEnabledFromEnv,
  drainModeEnabledFn = drainModeEnabledFromEnv,
  evaluateOverrunPolicyFn = evaluateOverrunPolicy,
  listCardUsageEntriesFn = listCardUsageEntries,
  releaseReservationFn = releaseReservation,
  recordManualOverrideFn = recordManualOverride
}) {
  const isManualOverride = trigger === LAUNCH_TRIGGERS.MANUAL;
  if (!orchestrator) {
    throw new CardLaunchError("Agent Runner is not configured on this server", 501);
  }
  const task = await orchestrator.store.get(id);
  if (!task) {
    throw new CardLaunchError(`Task ${id} not found`, 404);
  }
  if (!RUNNABLE_STATUSES.has(task.status)) {
    throw new CardLaunchError(
      `Cannot run ${id}: status is "${task.status}", expected "ready", "review", or "blocked"`,
      409
    );
  }
  // Mirrors RunOrchestrator.runCard's own "dispatch" guard (belt and suspenders, see
  // docs/design/escalation-workflow.md): a clean refusal here instead of letting the
  // fire-and-forget .catch() below turn it into a "Run Failed" note.
  if (task.agent === "dispatch") {
    throw new CardLaunchError(
      `Cannot run ${id}: assigned to "dispatch" -- awaiting human/Dispatch pickup, not eligible for automated runs`,
      409
    );
  }
  // Fix-plan item #6 (docs/reviews/2026-09-03-run-lifecycle-state-management.md), scoped to the
  // SAME card on purpose.
  //
  // `isRunning` reads the phase-level `activeRuns` map, which is empty whenever no child process
  // is spawned right now -- between the reviewer's FAIL and the next implementer attempt, and
  // between phases generally -- even though the card is still very much in flight. A re-launch
  // landing in that window used to pass this guard and start a second run of a card that already
  // had one. `activeCardIds` is the span-level set `runCard` holds for its entire lifetime, so
  // consulting it closes the window. (`runCard` re-checks it too; this is the earlier, cleaner
  // refusal that returns a 409 instead of a "Run Failed" note.)
  //
  // Deliberately NOT a board-wide "is anything running" check. Concurrent runs of DIFFERENT
  // cards are a supported capability, not an accident: on 2026-09-03 T-0290 (infra) and T-0273
  // (assets) ran side by side for 11 minutes with separate pids, worktrees and runstate files,
  // and both reached real verdicts. Refusing those would remove something that works.
  //
  // Optional-chained so an orchestrator without `activeCardIds` (older callers, test doubles)
  // degrades to the previous `isRunning`-only behaviour rather than throwing.
  if (orchestrator.isRunning(id) || orchestrator.activeCardIds?.has(id)) {
    throw new CardLaunchError(`Task ${id} already has an active run`, 409);
  }

  try {
    await assertCanMoveToInProgress(orchestrator.store, id);
    // T-0344: a card that has settled ROUND_CAP rounds without a promoted deliverable cannot
    // start another round until a human re-scopes it -- see roundCap.js.
    await assertRoundCapClear(orchestrator.store, id);
  } catch (err) {
    if (err instanceof UnmetDependencyError || err instanceof DependencyCycleError || err instanceof RoundCapExceededError) {
      throw new CardLaunchError(err.message, 409);
    }
    throw err;
  }

  // WIP gate T-D (spec §5/§10, launch-time contracts 2026-09-14): the shared launch boundary --
  // this is the one place both the Run button and the auto-launch poller launch through, so it
  // is where the admission/advisory/reservation machinery hooks in. Every step of it is bounded
  // and failure-isolated (buildLaunchDecide/withBoundedDecide): a throwing or hung telemetry
  // read, estimator, or reservation write degrades to an explicit hold record rather than ever
  // refusing or delaying the launch below. `orchestrator.runsDir` absent (an older or minimal
  // test double) skips this entirely and falls straight through to the plain launch, unchanged
  // from before this card.
  const runsDir = orchestrator.runsDir;
  const enforcementEnabled = enforcementEnabledFn();
  let executionId = null;
  let invocationId = null;
  let runCardPromise;

  if (runsDir) {
    try {
      // T-0370 fix round (Codex finding 3): bounded, not just error-caught -- a hung
      // ensureExecutionId read (not just a throwing one) must never keep runCard from being
      // called.
      executionId = await withTimeout(() => ensureExecutionIdFn({ runsDir, cardId: id }), {
        timeoutMs: DEFAULT_BOUND_MS,
        fallback: () => randomUUIDFn(),
        logger,
        label: `wip-gate advisory: ensureExecutionId(${id})`
      });
      invocationId = randomUUIDFn();
      const decide = buildLaunchDecideFn({
        runsDir,
        cardId: id,
        executionId,
        invocationId,
        type: resolveCostEstimatorType(task),
        owner: `cardLaunch:${id}`,
        maxAttempts: effectiveMaxAttempts(task),
        admissionConfig: loadAdmissionConfigFromEnvFn({ logger }),
        logger
      });

      // T-0370 fix round (Codex finding 2): the shared admission decision is only AUTHORITATIVE
      // (able to refuse the launch) under the enforcement flag -- default config always reaches
      // `orchestrator.runCard` exactly as it did before this card, since `advisory` is only
      // inspected below when `enforcementEnabled` is true. `advisory` is captured via this
      // closure rather than threaded through `withAdvisoryLoggingFn`'s own return, so `launch()`
      // can see what `decide()` produced without weakening `withAdvisoryLogging`'s own structural
      // guarantee that `launch()` always runs (see advisoryLogger.js).
      //
      // T-0370 fix round 2 finding 4: `decide()` itself is bounded HERE too, on top of whatever
      // bound `buildLaunchDecide`'s own `withBoundedDecide` already applies internally -- a
      // throwing or (in a test double) never-settling `decide` must never keep `withAdvisoryLogging`
      // from reaching `launch()`, under enforcement OR the default config alike. A timeout/error
      // here resolves to `advisory: null`, which `describeAdmissionRefusal` already treats as an
      // explicit hold under enforcement -- never a silent fall-through to an unconditional launch.
      let advisory = null;
      await withAdvisoryLoggingFn({
        decide: async () => {
          advisory = await withTimeout(() => decide(), {
            timeoutMs: DEFAULT_BOUND_MS,
            fallback: () => null,
            logger,
            label: `wip-gate advisory: launchCardRun decide() for ${id}`
          });
          return advisory;
        },
        launch: async () => {
          if (enforcementEnabled) {
            // T-0379: reservation-ledger integrity is never bypassable by trigger -- see
            // reservationIntegrityRefusal's own docstring.
            const integrityRefusal = reservationIntegrityRefusal(advisory?.admission);
            if (integrityRefusal) {
              await releaseReservationFn({ runsDir, cardId: id, executionId, invocationId, outcome: { status: "refused_enforcement", reason: integrityRefusal } }).catch(() => {});
              throw new CardLaunchError(`Cannot run ${id}: WIP gate hold (enforcement) -- ${integrityRefusal}`, 409);
            }

            // T-0379: the capacity-fit limit -- the ONE guard a manual (operator-initiated) launch
            // is allowed to bypass.
            const fitRefusal = capacityFitRefusal(advisory?.admission);
            if (fitRefusal) {
              if (!isManualOverride) {
                await releaseReservationFn({ runsDir, cardId: id, executionId, invocationId, outcome: { status: "refused_enforcement", reason: fitRefusal } }).catch(() => {});

                // WIP gate T-F (drain mode, spec §9): before this card would otherwise sit in the
                // poller's per-tick retry rotation forever, check whether the hold is a permanent
                // misfit -- no amount of waiting can help that, so retrying it every tick only
                // ever wastes a tick's one launch slot deciding not to use it. Gated on its own
                // flag on top of enforcement (drainModeEnabledFn): this auto-blocking behaviour is
                // a further refinement of what an enforcement hold DOES, not a new way to refuse a
                // launch, so it stays off even once enforcement itself is eventually turned on,
                // until Dennie separately opts into it. `isManualOverride` launches never reach
                // here at all (see the isManualOverride branch below), so a human-initiated Run
                // is never auto-blocked by this.
                if (drainModeEnabledFn()) {
                  const oversized = detectOversizedCard({ admission: advisory?.admission });
                  if (oversized) {
                    try {
                      const current = await orchestrator.store.get(id);
                      if (current) {
                        const updated = await orchestrator.store.update(id, {
                          status: "blocked",
                          body: appendNote(current.body ?? "", "WIP Gate: Drain Hold (Oversized)", oversized.reason)
                        });
                        orchestrator.hub?.broadcast?.({ type: "changed", id, task: updated });
                      }
                    } catch (holdErr) {
                      logger.log(`wip-gate drain mode: failed to record the oversized hold on ${id}: ${holdErr.message}`);
                    }
                    const oversizedErr = new CardLaunchError(`Cannot run ${id}: WIP gate drain hold (oversized) -- ${oversized.reason}`, 409);
                    oversizedErr.capacityFitHold = true;
                    oversizedErr.drainHeldOversized = true;
                    throw oversizedErr;
                  }
                }

                const err = new CardLaunchError(`Cannot run ${id}: WIP gate hold (enforcement) -- ${fitRefusal}`, 409);
                // The auto-launch poller's queue behaviour reads this to skip past a non-fitting
                // head-of-queue card to the next eligible one, rather than stalling the whole tick
                // on a per-card capacity determination -- see autoLaunchPoller.js. WIP gate T-F
                // (drain mode) reads the admission/telemetry readings below to track this card's
                // own bounded, aged wait -- see drainMode.js/autoLaunchPoller.js.
                err.capacityFitHold = true;
                err.admission = advisory?.admission ?? null;
                err.telemetryReadings = advisory?.telemetryReadings ?? null;
                throw err;
              }
              logger.log(`wip-gate enforcement: manual override for ${id} -- launching despite a capacity-fit hold: ${fitRefusal}`);
              await recordManualOverrideFn({ runsDir, cardId: id, executionId, invocationId, admission: advisory?.admission ?? null, reason: fitRefusal, logger }).catch((overrideErr) => {
                logger.log(`wip-gate enforcement: failed to record the manual override marker for ${id}: ${overrideErr.message}`);
              });
            }

            // Spec §11: an active overrun stop refuses a brand-new admission, but a card that is
            // already mid-cycle (this execution already has ledger history) may still continue --
            // refusing an in-flight card's own retry would abandon already-spent work rather than
            // bound it. T-0370's overrun response is UNCHANGED by T-0379 -- it applies regardless
            // of `trigger`; manual override only ever bypasses the capacity-fit limit above.
            const overrun = await evaluateOverrunPolicyFn({ runsDir });
            if (overrun.overrun) {
              let priorEntries = [];
              try {
                priorEntries = (await listCardUsageEntriesFn({ runsDir, cardId: id })).filter((entry) => entry.executionId === executionId);
              } catch {
                priorEntries = [];
              }
              if (!isBoundedContinuation({ priorEntriesForExecution: priorEntries })) {
                await releaseReservationFn({ runsDir, cardId: id, executionId, invocationId, outcome: { status: "refused_overrun_stop", reason: overrun.reason } }).catch(() => {});
                throw new CardLaunchError(`Cannot run ${id}: WIP gate overrun stop -- ${overrun.reason}`, 409);
              }
              logger.log(`wip-gate enforcement: overrun stop active but ${id} is a bounded continuation of an already-admitted execution -- allowed`);
            }
          }
          runCardPromise = orchestrator.runCard(id);
          return task;
        }
      });
    } catch (err) {
      if (err instanceof CardLaunchError) throw err;
      logger.log(`wip-gate advisory: launch-boundary advisory pipeline failed for ${id} -- launch proceeds unaffected: ${err.message}`);
      // T-0370 fix round 2 finding 4: under enforcement, a failure BUILDING or RUNNING the
      // decision (e.g. a throwing buildLaunchDecideFn -- a setup/policy error, never reaching
      // withAdvisoryLoggingFn's own decide()/launch() at all) is itself a refusal, exactly like an
      // explicit admission hold. Falling through to the unconditional launch below would let a
      // pipeline error bypass enforcement entirely -- the one thing the flag exists to prevent.
      if (enforcementEnabled) {
        if (isManualOverride) {
          // T-0379: same bypass as the capacity-fit hold above -- a broken advisory/admission
          // pipeline is unknown capacity, not proof of overrun, so manual override still applies.
          logger.log(`wip-gate enforcement: manual override for ${id} -- advisory/admission pipeline failed, launch proceeds unaffected: ${err.message}`);
        } else {
          if (runsDir && executionId !== null && invocationId !== null) {
            await releaseReservationFn({
              runsDir,
              cardId: id,
              executionId,
              invocationId,
              outcome: { status: "refused_enforcement", reason: `advisory pipeline error: ${err.message}` }
            }).catch(() => {});
          }
          const pipelineErr = new CardLaunchError(`Cannot run ${id}: WIP gate hold (enforcement) -- advisory/admission pipeline failed: ${err.message}`, 409);
          pipelineErr.capacityFitHold = true;
          throw pipelineErr;
        }
      }
    }
  }

  // The advisory branch above always reaches `launch()` in every failure mode it itself
  // anticipates (withAdvisoryLoggingFn's own contract guarantees `launch()` runs regardless of
  // what `decide()` does), and the catch above already refuses under enforcement before ever
  // reaching here. This is the true last resort, reachable only with enforcement OFF: `runCardPromise`
  // is still unset only if something upstream of `launch()` itself threw synchronously (e.g.
  // building the decide function) -- constraint 6 requires the launch to proceed even then.
  if (!runCardPromise) {
    runCardPromise = orchestrator.runCard(id);
  }

  if (runsDir && executionId !== null && invocationId !== null) {
    runCardPromise.then(
      () => reconcileLaunchOutcomeFn({ runsDir, cardId: id, executionId, invocationId, status: "completed", logger }),
      (err) => reconcileLaunchOutcomeFn({ runsDir, cardId: id, executionId, invocationId, status: "failed", errorMessage: err.message, logger })
    );
  }

  runCardPromise.catch(async (err) => {
    logger.error(`Agent Runner: run failed for ${id}:`, err);
    try {
      const current = await orchestrator.store.get(id);
      if (current) {
        const updated = await orchestrator.store.update(id, {
          status: "blocked",
          body: appendNote(current.body ?? "", "Run Failed", err.message)
        });
        if (orchestrator.hub) {
          orchestrator.hub.broadcast({ type: "changed", id, task: updated });
        }
      }
    } catch (e2) {
      logger.error(`Agent Runner: failed to persist run failure for ${id}:`, e2);
    }
  });

  return task;
}
