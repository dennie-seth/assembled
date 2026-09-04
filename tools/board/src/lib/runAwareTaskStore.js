import { TaskStore } from "./taskStore.js";

/**
 * Store-boundary transition validation -- fix-plan item #5 of
 * `docs/reviews/2026-09-03-run-lifecycle-state-management.md` (§2.3).
 *
 * The review's consolidated root cause (§1.1): card status has **two independent writers** --
 * `RunOrchestrator`, whose `activeCardIds` set is in-memory, exact and authoritative, and
 * `orphanReaper`, which infers liveness from filesystem artifacts that go stale during normal
 * operation and writes `blocked` anyway. They share the same Set by reference
 * (`boardServer.js`: `activeCardIds: orchestrator.activeCardIds`), so the reaper *can* see the
 * truth -- it just used it as a coarse skip-list rather than as the authority for the write.
 * Last-writer-wins on a shared mutable field produced eight false `blocked` reaps of T-0290 in
 * one day, every one of them against a run that was alive and writing.
 *
 * #322 fixed that at the reaper: it now suppresses its own status writes for a card the
 * orchestrator owns. **This module is the layer beneath it** -- defense in depth, so the
 * invariant holds even for a writer that never consults ownership at all, present or future.
 *
 * ## Ownership is a capability, not a caller identity
 *
 * There is deliberately no actor string, token or "who is calling" check. `boardServer` hands
 * the **orchestrator the raw store** and every other consumer this guarded view. A writer's
 * authority is therefore determined by which object it was given, which means:
 *
 *   - nothing has to remember to pass a token on every call, and
 *   - there is no "unidentified caller is trusted by default" hole -- the usual failure mode of
 *     identity-based guards, and the one that would have let a new writer re-introduce this bug.
 *
 * It also means this needs **no change to `runOrchestrator.js`**: the owner keeps writing
 * exactly as it does today, through a store that simply is not wrapped.
 *
 * ## Why only `blocked`
 *
 * `blocked` is the only status the inferring writer ever produces (§1.1), and a spurious
 * `blocked` on a live run is the failure this exists to prevent. Guarding more would be
 * speculative and would risk rejecting a legitimate transition -- the orchestrator's own
 * `in-progress` -> `validation` -> `review`/`blocked` progression must stay unimpeded, and it
 * does, because the orchestrator does not hold this view.
 */

/** The guarded transition was refused. `statusCode` lets an HTTP caller surface it as 409. */
export class LiveRunTransitionError extends Error {
  constructor(taskId, attemptedStatus) {
    super(
      `Refusing to set ${taskId} to "${attemptedStatus}": a live run owns this card. ` +
        `Only the run's owner (RunOrchestrator) may write a terminal status while the run is ` +
        `in flight -- see docs/reviews/2026-09-03-run-lifecycle-state-management.md §2.3.`
    );
    this.name = "LiveRunTransitionError";
    this.taskId = taskId;
    this.attemptedStatus = attemptedStatus;
    this.statusCode = 409;
  }
}

/** Statuses a non-owner may not write while a run is live. See "Why only `blocked`" above. */
export const GUARDED_STATUSES = Object.freeze(["blocked"]);

/**
 * Wraps a TaskStore so non-owner status writes to a live card are refused.
 *
 * @param {object}   opts
 * @param {object}   opts.store        the underlying TaskStore (fs or db) to delegate to
 * @param {(id:string)=>boolean} [opts.isRunLive]
 *        liveness oracle, read at WRITE time so the shared `activeCardIds` set stays
 *        authoritative as runs come and go. Omitted => guards nothing, so a mis-wire degrades to
 *        today's behaviour rather than locking the board.
 * @param {string[]} [opts.guardedStatuses]
 */
export function createRunAwareTaskStore({ store, isRunLive, guardedStatuses = GUARDED_STATUSES }) {
  if (!store) throw new Error("createRunAwareTaskStore requires a store to delegate to");

  const guarded = new Set(guardedStatuses);
  const live = (id) => (typeof isRunLive === "function" ? Boolean(isRunLive(id)) : false);

  const assertAllowed = (id, status) => {
    if (status === undefined || status === null) return;
    if (!guarded.has(status)) return;
    if (!live(id)) return;
    throw new LiveRunTransitionError(id, status);
  };

  class RunAwareTaskStore extends TaskStore {
    async list(...args) {
      return store.list(...args);
    }

    async get(id, ...args) {
      return store.get(id, ...args);
    }

    // create is not guarded: a brand-new card cannot have a run in flight, and refusing here
    // would break remediation-card creation, which happens *during* the owning run.
    async create(task, ...args) {
      return store.create(task, ...args);
    }

    async update(id, updates, ...args) {
      assertAllowed(id, updates?.status);
      return store.update(id, updates, ...args);
    }

    async move(id, status, ...args) {
      assertAllowed(id, status);
      return store.move(id, status, ...args);
    }

    async remove(id, ...args) {
      return store.remove(id, ...args);
    }
  }

  return new RunAwareTaskStore();
}
