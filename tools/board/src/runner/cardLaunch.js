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
