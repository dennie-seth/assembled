/**
 * The experiment-round cap (T-0344).
 *
 * A **round** is one full re-launch of a card after a settled verdict -- a fresh `runCard()`
 * invocation, started by a human clicking Run (or the auto-launch poller), that ends either in
 * `review` (a PASS, a promoted deliverable) or `blocked` (exhausted retries or a
 * NEEDS_HUMAN_DECISION verdict, no deliverable). This is a different unit than an **attempt**:
 * the bounded implementer/reviewer retry loop *inside* one round (`runOrchestrator.js`'s
 * `attempts`/`max_attempts`, T-0343) -- a round can burn many attempts before it settles, and
 * settling is what this module counts.
 *
 * Motivated by T-0272/T-0317 (twelve rounds, 84 attempts against a mechanism wrong from round
 * one) and T-0259 (thirteen sessions) -- nothing in the loop forced a human to look up until the
 * cost was already spent. Two rounds is enough to learn whether an approach is working; a third
 * round requires an explicit human re-scope first.
 *
 * The mechanism, deliberately small and mirroring `approvalGate.js`'s own shape: a card carries
 * a `round` counter (frontmatter field, defaults to 0 -- so the cap is never retroactive against
 * a card that already has a history predating this field). `runOrchestrator.js` increments it by
 * exactly 1 each time a run settles `blocked` without a deliverable, and resets it to 0 on a
 * PASS. Once `round` reaches `ROUND_CAP`, `cardLaunch.js`/`httpApi.js` refuse to start another
 * round (`assertRoundCapClear`) until a human comments a rescope marker on the card, which
 * resets `round` back to 0 and stamps `rescoped_by`/`rescoped_at` -- the same comment-marker
 * idiom the human direction-approval gate already uses for "APPROVED".
 */

/** Frontmatter field naming the counter. */
export const ROUND_FIELD = "round";
/** The number of no-deliverable rounds a card may settle before a re-launch is refused. */
export const ROUND_CAP = 2;
/** Fields recording the human re-scope acknowledgment. Derived by the server, never accepted from a request body. */
export const RESCOPE_RECORD_FIELDS = Object.freeze(["rescoped_by", "rescoped_at"]);
/**
 * The rescope markers. A comment approves only when its **first non-empty line** is exactly one
 * of these (case-insensitive, surrounding whitespace ignored) -- same reasoning as
 * `approvalGate.js`'s `APPROVAL_MARKERS`: it lets a human explain the new approach underneath
 * without a comment that merely *discusses* re-scoping acting as one.
 */
export const RESCOPE_MARKERS = Object.freeze(["rescoped", "/rescope"]);

/** The number of rounds `task` has settled without a promoted deliverable since it was last reset. */
export function roundsSinceDeliverable(task) {
  return Number.isInteger(task?.round) && task.round >= 0 ? task.round : 0;
}

/** True if `task` has settled `ROUND_CAP` or more rounds without a promoted deliverable. */
export function roundCapReached(task) {
  return roundsSinceDeliverable(task) >= ROUND_CAP;
}

/** Does `text` carry a rescope marker? See `RESCOPE_MARKERS` for why only the first non-empty line counts. */
export function isRescopeMarker(text) {
  if (typeof text !== "string") return false;
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return false;
  return RESCOPE_MARKERS.includes(firstLine.toLowerCase());
}

/** The `{ round, rescoped_by, rescoped_at }` patch recording a human re-scope acknowledgment by `actor` at `now`. */
export function rescopeRecord({ actor, now = new Date() }) {
  const by = typeof actor === "string" && actor.trim().length > 0 ? actor.trim() : "unknown";
  return { round: 0, rescoped_by: by, rescoped_at: now.toISOString() };
}

/** Raised when a launch is refused because `task` has settled `ROUND_CAP` rounds without a promoted deliverable. */
export class RoundCapExceededError extends Error {
  constructor(taskId, round) {
    super(
      `Cannot run ${taskId}: ${round} rounds have settled without a promoted deliverable ` +
        `(cap is ${ROUND_CAP}) -- a human must re-scope this card before another round can start. ` +
        `Comment "RESCOPED" (or "/rescope") on the card to acknowledge the re-scope and clear the cap.`
    );
    this.name = "RoundCapExceededError";
    this.taskId = taskId;
    this.round = round;
  }
}

/**
 * The comment posted when a round settling brings `task` to the cap -- the discoverable "what is
 * being asked, and how do I unblock it" record on the card itself, mirroring
 * `approvalGate.js`'s `parkedForApprovalComment`.
 */
export function roundCapParkedComment(taskId, round) {
  return (
    `ROUND CAP REACHED -- ${taskId} has settled ${round} of ${ROUND_CAP} rounds (full re-launches ` +
    "after a settled verdict, not auto-retry attempts within a run) without a promoted " +
    "deliverable. A third round cannot start automatically.\n\n" +
    `To continue: a human must re-scope the approach and comment "RESCOPED" (or "/rescope") on ` +
    `${taskId} -- this resets the round counter and unblocks the next run.`
  );
}

/** The confirmation comment recording who acknowledged the re-scope and when. */
export function rescopeRecordedComment({ actor, rescopedAt }) {
  return `RESCOPE RECORDED -- acknowledged by ${actor} at ${rescopedAt}. The round counter is reset; the card can be run again.`;
}

/**
 * Guards a card's next round the way `dependencyGuard.assertCanMoveToInProgress` guards its
 * dependencies -- resolves for a card below the cap (or a missing card, whose 404 is
 * `store.update`'s to report, not this guard's), throws `RoundCapExceededError` otherwise.
 */
export async function assertRoundCapClear(store, taskId) {
  const task = await store.get(taskId);
  if (!task) return;
  if (roundCapReached(task)) {
    throw new RoundCapExceededError(taskId, roundsSinceDeliverable(task));
  }
}

