import { assertCanMoveToInProgress, UnmetDependencyError, DependencyCycleError } from "../lib/dependencyGuard.js";
import { appendNote } from "./runOrchestrator.js";

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
 * check, the board-wide active-run check (fix-plan item #6), and `assertCanMoveToInProgress` (docs/board-invariants.md RUN-3 / LC-5 -- a run moves
 * the card to in-progress the same way a manual PATCH does, so it must clear the same
 * dependency/cycle guard). The acceptance/capability preflights run inside `runCard` itself.
 *
 * Fire-and-forget by design: a run (implementer + reviewer) takes minutes, and callers follow
 * progress over the board WS, not this call. A failure inside the run is persisted onto the card
 * as `blocked` + a "Run Failed" note and broadcast, exactly as before -- and a failure to persist
 * *that* is logged and swallowed, since there is nothing left to report it to.
 */
export async function launchCardRun({ orchestrator, id, logger = console }) {
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
  if (orchestrator.isRunning(id)) {
    throw new CardLaunchError(`Task ${id} already has an active run`, 409);
  }
  // Fix-plan item #6 (docs/reviews/2026-09-03-run-lifecycle-state-management.md) -- the
  // board-wide double-launch guard, and the one this module was missing.
  //
  // The check above is per-card. Nothing refused launching a DIFFERENT card on top of a live
  // run, which is how T-0284 landed on top of T-0243 on 2026-09-03. The auto-launch poller had
  // its own idle gate, but this path -- POST /api/tasks/:id/run, i.e. the Run button -- had
  // none, so the protection existed on one caller and not the other.
  //
  // Deliberately keyed on `hasActiveRuns()` (activeCardIds) rather than `isRunning` (the
  // phase-level activeRuns map): the latter empties between the reviewer's FAIL and the next
  // implementer attempt, and between phases generally, while the card is still very much in
  // flight. Reading the narrower signal here would leave the hole open for exactly the windows
  // where a stray launch is most likely.
  //
  // Ordered after the same-card check so a duplicate click on the running card keeps its
  // specific message instead of the generic board-busy one.
  //
  // Guarded with a capability check so an orchestrator without `hasActiveRuns` (older callers,
  // test doubles) degrades to the previous behaviour rather than throwing.
  if (typeof orchestrator.hasActiveRuns === "function" && orchestrator.hasActiveRuns()) {
    const active = orchestrator.activeCardIds ? [...orchestrator.activeCardIds].join(", ") : "another card";
    throw new CardLaunchError(
      `Cannot run ${id}: a card run is already active (${active}). The board runs one card at a time; ` +
        `wait for it to finish, or stop it first.`,
      409
    );
  }

  try {
    await assertCanMoveToInProgress(orchestrator.store, id);
  } catch (err) {
    if (err instanceof UnmetDependencyError || err instanceof DependencyCycleError) {
      throw new CardLaunchError(err.message, 409);
    }
    throw err;
  }

  orchestrator.runCard(id).catch(async (err) => {
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
