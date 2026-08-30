import { ASSIGNABLE_AGENT_NAMES } from "./taskParser.js";

/**
 * The human direction-approval gate.
 *
 * Why this exists: a card whose real deliverable is a *direction* -- concept art, a style
 * sheet, an architectural choice -- is not finished when the artifact exists. It is finished
 * when a human has looked at the artifact and said yes. Before this module there was no way
 * to say that on a card, so the two were indistinguishable: a PASS settled the card into
 * `review` (runOrchestrator's `_handlePass`), and the Review -> Done flip was one unlabelled
 * drag that recorded nothing about *why* it happened. `dependencyGuard` treats `done` as a
 * satisfied dependency, so whoever made that flip -- for any reason, including "the artifact
 * looks produced" -- unblocked every downstream card.
 *
 * That is not hypothetical. T-0239 produced a *synthetic* props concept sheet (labelled
 * silhouettes composited by a script, not generated prop geometry), reached `review` on a
 * reviewer PASS, went `done` four minutes later, and T-0243 duly unblocked and generated room
 * props against an unapproved reference. Nothing in the board was wrong by its own rules --
 * approval simply was not modelled anywhere.
 *
 * The fix, deliberately small: cards carry an explicit `requires_approval` flag; such a card
 * parks in `review` with a comment saying so; and the only thing that can move it to `done`
 * is a *human* act -- dragging it to Done, or commenting the approval marker -- which is
 * recorded on the card as `approved_by` / `approved_at`. `dependencyGuard` is untouched: it
 * already only counts `done`/`retired`, so production parking at `review` is exactly what
 * keeps dependents blocked, and approval moving the card to `done` is exactly what releases
 * them.
 *
 * On strength: the "is this a human?" test below is a **guardrail, not a sandbox** -- the same
 * stance `agentCurlPolicy.js` documents for itself. The load-bearing barriers are (a) no agent
 * holds an unscoped HTTP grant at all (only `assets`/`audio` get `agentCurl.js`, whose policy
 * already refuses every mutating board route except attachment upload), and (b)
 * `assertRunnerMayApply` below, which makes it impossible for the orchestrator's own write
 * path to complete an unapproved approval-card no matter what an agent talks it into. The
 * actor check is the third layer, catching a future agent that gains comment/PATCH rights.
 */

/** Frontmatter/API field naming the gate. Explicit, not inferred from body prose. */
export const REQUIRES_APPROVAL_FIELD = "requires_approval";
/** Fields recording the approval act. Derived by the server -- never accepted from a request body. */
export const APPROVAL_RECORD_FIELDS = Object.freeze(["approved_by", "approved_at"]);

/** The status an approval-required card parks in once its run PASSes. */
export const PARKED_STATUS = "review";

/**
 * Actor identities that are never human. `agent` is what `agentCurl.js` stamps on every
 * request it forwards; the rest are the names the orchestrator and the agent catalog write
 * comments under (`_appendComment(taskId, "assembled-board", ...)`, reviewer/implementer
 * phase notes), so an approval marker arriving under one of them is refused even if it
 * somehow reached the comments endpoint.
 */
export const AGENT_ACTOR_IDENTITIES = Object.freeze(
  new Set([
    "agent",
    "agents",
    "assembled-board",
    "board",
    "runner",
    "agent-runner",
    "orchestrator",
    "implementer",
    "reviewer",
    "system",
    ...ASSIGNABLE_AGENT_NAMES
  ])
);

/** Request header carrying the caller's identity; `agentCurl.js` always sends `agent`. */
export const ACTOR_HEADER = "x-board-actor";
/** Value the browser client sends, so a human action has a name in `approved_by`. */
export const BOARD_UI_ACTOR = "board-ui";
/** Recorded when a caller sends no actor header at all (e.g. a human's own `curl`). */
export const UNKNOWN_ACTOR = "unknown";

/**
 * The approval markers. A comment approves only when its **first non-empty line** is exactly
 * one of these (case-insensitive, surrounding whitespace ignored). Requiring the first line --
 * rather than "contains the word somewhere" -- is what stops a comment that merely *discusses*
 * approval ("the sheet says APPROVED in the corner", "not approved yet") from acting as one,
 * while still allowing a human to explain themselves underneath:
 *
 *     APPROVED
 *
 *     Reads as one vocabulary with v1 -- ship it.
 */
export const APPROVAL_MARKERS = Object.freeze(["approved", "/approve"]);

/** True if `task` is gated on a human direction verdict. */
export function requiresApproval(task) {
  return Boolean(task && task[REQUIRES_APPROVAL_FIELD]);
}

/** True if a human has already approved `task` (an approval is recorded on it). */
export function isApproved(task) {
  return Boolean(task && typeof task.approved_by === "string" && task.approved_by.length > 0);
}

/** True if `task` still needs a human verdict before it may reach `done`. */
export function needsApproval(task) {
  return requiresApproval(task) && !isApproved(task);
}

/** Normalizes an actor/author string for comparison against `AGENT_ACTOR_IDENTITIES`. */
function normalizeActor(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Is this actor an agent? Fail-closed on the identity itself (anything in the reserved set,
 * and anything shaped `agent:<name>`), fail-open on absence -- a caller with no header is a
 * human at a terminal, since no agent can reach the board API without going through
 * `agentCurl.js`, which always stamps one.
 */
export function isAgentActor(value) {
  const actor = normalizeActor(value);
  if (actor.length === 0) return false;
  if (actor.startsWith("agent:")) return true;
  return AGENT_ACTOR_IDENTITIES.has(actor);
}

/** Convenience inverse of `isAgentActor`, for the "may this caller approve?" question. */
export function isHumanActor(value) {
  return !isAgentActor(value);
}

/** Reads the actor identity off a Node request's headers, defaulting to `UNKNOWN_ACTOR`. */
export function actorFromHeaders(headers = {}) {
  const raw = headers[ACTOR_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : UNKNOWN_ACTOR;
}

/**
 * Does `text` carry an approval marker? See `APPROVAL_MARKERS` for why only the first
 * non-empty line counts.
 */
export function isApprovalMarker(text) {
  if (typeof text !== "string") return false;
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return false;
  return APPROVAL_MARKERS.includes(firstLine.toLowerCase());
}

/** The `{ approved_by, approved_at }` patch recording an approval by `actor` at `now`. */
export function approvalRecord({ actor, now = new Date() }) {
  const by = typeof actor === "string" && actor.trim().length > 0 ? actor.trim() : UNKNOWN_ACTOR;
  return { approved_by: by, approved_at: now.toISOString() };
}

/** Raised when something that is not a human approval tries to complete an approval-gated card. */
export class ApprovalRequiredError extends Error {
  constructor(taskId) {
    super(
      `Cannot move ${taskId} to done: it requires a human direction approval. ` +
        `A human must approve it (drag it to Done in the board UI, or comment "APPROVED" on it) -- ` +
        `agents and the runner never approve their own work.`
    );
    this.name = "ApprovalRequiredError";
    this.taskId = taskId;
  }
}

/**
 * The runner-side half of the gate, called from `RunOrchestrator._updateAndBroadcast` -- the
 * single chokepoint every orchestrator write passes through. Today no run path sets `done`
 * (a PASS settles at `review`), so this never fires in normal operation; it exists so that a
 * future run path, a reviewer-driven shortcut, or an agent that talks the orchestrator into
 * writing `done` cannot silently release an unapproved card's dependents. Approval-required
 * cards are completed by humans only, and this is the code that makes that a fact rather than
 * a convention.
 */
export function assertRunnerMayApply(task, patch) {
  if (!patch || patch.status !== "done") return;
  if (!needsApproval(task)) return;
  throw new ApprovalRequiredError(task.id);
}

/**
 * The comment posted when an approval-required card's run PASSes. Written by the board itself
 * (author `assembled-board`), so it is also an example of a comment that must never be
 * mistaken for an approval -- `isAgentActor("assembled-board")` is true.
 */
export function parkedForApprovalComment(taskId) {
  return (
    "PARKED FOR HUMAN APPROVAL — the artifact is produced; a human must approve before " +
    "dependents unblock.\n\n" +
    'To APPROVE: move this card to Done (or comment "APPROVED").\n' +
    "To reject: comment the changes needed and re-run.\n\n" +
    `Until then ${taskId} stays in review, and every card that depends on it stays blocked.`
  );
}

/** The confirmation comment recording who approved and when. */
export function approvalRecordedComment({ actor, approvedAt }) {
  return `APPROVAL RECORDED — approved by ${actor} at ${approvedAt}. Dependents are now unblocked.`;
}
