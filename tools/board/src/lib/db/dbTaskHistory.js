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
export function readTaskBodyBeforeRun(db, id) {
  const rows = db
    .prepare("SELECT action, changed, body FROM card_events WHERE task_id = ? ORDER BY id DESC")
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
  if (statusTransitions.length < 2) {
    return "";
  }

  return statusTransitions[1].body;
}
