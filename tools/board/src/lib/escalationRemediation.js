const MARKER_RE = /<!-- escalation-remediation-for: (T-\d{4}) -->/;

const CATEGORY_LABELS = {
  "permission-grant": "Permission/grant",
  tool: "Tool",
  "env-dependency": "Environment/dependency",
  "external-service": "External service",
  "design-ambiguity": "Design ambiguity",
  "code-test-bug": "Code/test bug"
};

/** True iff `task`'s body carries the escalation-remediation marker for `originalId` -- the de-dupe key (mirrors flowImprovementCard.js's isAutoProposedCard). */
export function isRemediationCardFor(task, originalId) {
  const body = task && task.body;
  if (typeof body !== "string") return false;
  const match = MARKER_RE.exec(body);
  return Boolean(match && match[1] === originalId);
}

/** Finds the remediation card already open for `originalId` among `tasks`, or null if none exists yet. */
export function findExistingRemediationCard(tasks, originalId) {
  return tasks.find((task) => isRemediationCardFor(task, originalId)) ?? null;
}

/**
 * Turns a blocked card's structured blocker report into a normal card's fields --
 * `status: "ready"` and `agent: "dispatch"` always, so it surfaces immediately for a human
 * (Dispatch) to grab and is never picked up by an automated run (see RunOrchestrator.runCard's
 * pick-up-loop skip in docs/design/escalation-workflow.md). Pure function, no I/O;
 * `cardCreation.js`'s `createCard` is what actually writes it, exactly like
 * flowImprovementCard.js's `draftImprovementCard`.
 */
export function draftRemediationCard({ task, report, attemptCount, now = () => new Date() }) {
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
