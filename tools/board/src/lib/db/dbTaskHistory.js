/**
 * T-0342: the "before this run" body snapshot for a DB-mode task -- the db-mode equivalent of
 * gitTaskHistory.js's readTaskBodyAtMergeBase, which pins fs-mode's finding-with-evidence route
 * to the task body as it stood before the reviewed branch diverged from base. DB-mode tasks are
 * never committed to git (dbTaskStore.js's whole premise -- card_events is its own audit trail,
 * replacing git history per 0001_init.sql), so there is no merge-base to read; this reconstructs
 * an equivalent boundary from card_events instead, using the full body snapshot migration 0005
 * added to every event row.
 *
 * "This run" = the current implementer attempt, bounded by the most recent transition INTO
 * `in-progress`. checkDeliverable.js only ever runs while the reviewer is validating a card --
 * i.e. while the card's live status is "validation" -- so the single most recent status-changing
 * event is always the entry into validation that immediately preceded this reviewer invocation
 * (runOrchestrator.js's only path to `status: "validation"` is from `in-progress`, right before
 * invoking the reviewer -- see runCard()). The SECOND most recent status-changing event is
 * therefore always the entry into "in-progress" that began the attempt being reviewed, and that
 * event's stored body snapshot is exactly the body as it stood the moment this run started -- a
 * body edit made *during* this run (e.g. adding "## Pre-registered experiment" retroactively)
 * always lands in a LATER event and is invisible here, giving db mode the same anti-retroactive
 * guarantee readTaskBodyAtMergeBase gives fs mode.
 */
/**
 * The card_events row marking the start of the current attempt -- the second-most-recent status
 * transition, i.e. the entry into `in-progress` that immediately preceded the entry into
 * `validation` that always precedes a `checkDeliverable.js` invocation (see this file's own
 * top-of-file docstring for why that ordering is guaranteed). `null` when fewer than two status
 * transitions exist, so both `readTaskBodyBeforeRun` and `readRunStartTimestamp` share one safe
 * "unknown run start" default rather than two copies of the same query and filter.
 */
function findRunStartTransition(db, id) {
  const rows = db
    .prepare("SELECT action, changed, body, created_at FROM card_events WHERE task_id = ? ORDER BY id DESC")
    .all(id);

  const statusTransitions = rows.filter((row) => {
    if (row.action !== "update") return false;
    try {
      return JSON.parse(row.changed).includes("status");
    } catch {
      return false;
    }
  });

  // Fewer than two known transitions means "the start of this run" can't be pinned down --
  // the same safe default readTaskBodyAtMergeBase uses for an unresolvable git ref: the caller
  // (checkDeliverable.js) falls through to the plain artifact-required check rather than ever
  // treating "unknown" as "pre-registered".
  return statusTransitions.length < 2 ? null : statusTransitions[1];
}

export function readTaskBodyBeforeRun(db, id) {
  return findRunStartTransition(db, id)?.body ?? "";
}

/**
 * T-0354: the freshness gate's db-mode "run start" boundary -- the wall-clock counterpart to
 * `readTaskBodyBeforeRun`'s body snapshot, from the exact same event (`card_events.created_at` is
 * stamped by `dbTaskStore.js` with `new Date().toISOString()` on every transition). Precise per
 * *attempt*, not per card: a retry's own `in-progress` re-entry is a later, distinct event, so a
 * stale artifact from an earlier, already-failed attempt can never be mistaken for evidence this
 * attempt invoked the model.
 */
export function readRunStartTimestamp(db, id) {
  return findRunStartTransition(db, id)?.created_at ?? "";
}
