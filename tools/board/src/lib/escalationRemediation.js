const MARKER_RE = /<!-- escalation-remediation-for: (T-\d{4}) -->/;

const CATEGORY_LABELS = {
  "permission-grant": "Permission/grant",
  tool: "Tool",
  "env-dependency": "Environment/dependency",
  "external-service": "External service",
  "design-ambiguity": "Design ambiguity",
  "code-test-bug": "Code/test bug"
};

/**
 * Statuses in which a remediation card is closed -- no longer a live gate for its parent.
 * `retired` is the explicit human "this is not the way forward" verdict; `done` is ordinary
 * completion. Neither is eligible for re-linking as a fresh dependency (T-0310): the escalation
 * dedupe must check status, not mere existence, or a second escalation re-attaches its parent to
 * a card nobody will ever act on again.
 */
export const CLOSED_REMEDIATION_STATUSES = new Set(["done", "retired"]);

export function isClosedRemediationStatus(status) {
  return CLOSED_REMEDIATION_STATUSES.has(status);
}

/** True iff `task`'s body carries the escalation-remediation marker for `originalId` -- the de-dupe key (mirrors flowImprovementCard.js's isAutoProposedCard). */
export function isRemediationCardFor(task, originalId) {
  const body = task && task.body;
  if (typeof body !== "string") return false;
  const match = MARKER_RE.exec(body);
  return Boolean(match && match[1] === originalId);
}

/** Finds a remediation card for `originalId` among `tasks` by marker alone, regardless of status, or null if none exists yet. */
export function findExistingRemediationCard(tasks, originalId) {
  return tasks.find((task) => isRemediationCardFor(task, originalId)) ?? null;
}

/** Every remediation card (open or closed) filed against `originalId`, in list order. */
export function findRemediationCardsFor(tasks, originalId) {
  return tasks.filter((task) => isRemediationCardFor(task, originalId));
}

/**
 * The remediation card for `originalId` that is still open (not `done`/`retired`), or null when
 * every match is closed or none exist. A long escalation history can carry several closed cards
 * for the same parent -- this only ever returns one that's actually still actionable.
 */
export function findOpenRemediationCard(tasks, originalId) {
  return findRemediationCardsFor(tasks, originalId).find((task) => !isClosedRemediationStatus(task.status)) ?? null;
}

function taskIdSequence(id) {
  const match = /(\d+)/.exec(id ?? "");
  return match ? Number(match[1]) : -Infinity;
}

/**
 * The most recently created closed remediation card for `originalId` (highest task id), or null
 * when none is closed. Used to name what a fresh escalation supersedes -- picking correctly
 * across a long history matters more than matching whichever closed card happens to sort first.
 */
export function findMostRecentClosedRemediationCard(tasks, originalId) {
  const closed = findRemediationCardsFor(tasks, originalId).filter((task) => isClosedRemediationStatus(task.status));
  if (closed.length === 0) return null;
  return closed.reduce((latest, task) => (taskIdSequence(task.id) > taskIdSequence(latest.id) ? task : latest));
}

/**
 * Turns a blocked card's structured blocker report into a normal card's fields --
 * `status: "ready"` and `agent: "dispatch"` always, so it surfaces immediately for a human
 * (Dispatch) to grab and is never picked up by an automated run (see RunOrchestrator.runCard's
 * pick-up-loop skip in docs/design/escalation-workflow.md). Pure function, no I/O;
 * `cardCreation.js`'s `createCard` is what actually writes it, exactly like
 * flowImprovementCard.js's `draftImprovementCard`.
 */
export function draftRemediationCard({ task, report, attemptCount, now = () => new Date(), supersedes = null }) {
  const dateStr = now().toISOString().slice(0, 10);
  const marker = `<!-- escalation-remediation-for: ${task.id} -->`;
  const label = CATEGORY_LABELS[report.lacks.category] ?? report.lacks.category;
  const contextLine = report.noProgress
    ? `Auto-escalated after \`${task.id}\` (${task.title}) had its auto-retry loop aborted for no progress after ${attemptCount} attempt(s) (proposed ${dateStr}).`
    : `Auto-escalated after \`${task.id}\` (${task.title}) exhausted ${attemptCount} auto-retry attempts (proposed ${dateStr}).`;

  const body = [
    marker,
    "",
    "## Context",
    "",
    contextLine,
    ...(supersedes
      ? [
          "",
          `**Supersedes:** \`${supersedes.id}\` (closed: ${supersedes.status}) -- that remediation did not resolve the blocker; this card carries the current failure.`
        ]
      : []),
    "",
    "## Blocker report",
    "",
    `**Attempted:** ${report.attempted}`,
    "",
    ...(report.abortReason ? [`**Abort reason:** ${report.abortReason}`, ""] : []),
    "**Failure signature across attempts:**",
    "",
    report.failureSignature,
    "",
    `**Lacks:** ${label} — ${report.lacks.detail}`,
    "",
    "## Acceptance",
    "",
    `- [ ] Root cause behind \`${task.id}\`'s blocker resolved (${label.toLowerCase()} fix as identified above)`,
    `- [ ] \`${task.id}\` re-run succeeds once this is resolved`
  ].join("\n");

  return {
    title: `Unblock ${task.id}: ${label} — ${task.title}`,
    status: "ready",
    priority: task.priority ?? "P2",
    phase: task.phase ?? 0,
    agent: "dispatch",
    depends_on: [],
    deliverable_type: "code",
    body
  };
}
