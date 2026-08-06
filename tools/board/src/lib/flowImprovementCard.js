const BASELINE_MARKER_RE = /<!-- flow-stats-self-improve: baseline-done=(\d+) -->/;

/** True iff a task's body carries the auto-proposal marker this module writes -- used for de-dupe (see selfImprovementTrigger.js). */
export function isAutoProposedCard(task) {
  const body = task && task.body;
  return typeof body === "string" && BASELINE_MARKER_RE.test(body);
}

/** Returns the `done` count recorded as this card's baseline, or null if the card carries no marker. */
export function extractBaselineDone(body) {
  const match = BASELINE_MARKER_RE.exec(body ?? "");
  return match ? Number(match[1]) : null;
}

function percent(rate) {
  return `${Math.round(rate * 100)}%`;
}

function contextSection(stats) {
  const statusLines = Object.entries(stats.byStatus)
    .map(([status, count]) => `- ${status}: ${count}`)
    .join("\n");
  return [
    "## Context",
    "",
    "Auto-proposed by the flow-stats self-improvement loop " +
      "(see `docs/design/flow-stats-self-improvement.md`).",
    "",
    `Snapshot: ${stats.totalCards} total cards.`,
    statusLines,
    "",
    `Rework rate: ${percent(stats.reworkRate)} (${stats.reworkTotal} FAIL / ${stats.reworkSample} validation notes).`,
    `Cards blocked after exhausting the auto-retry cap: ${stats.retryCapBlockedCount}.`,
    `Orphan-reaper recoveries recorded: ${stats.recoveredTotal}.`,
    `Average rework per card that reached done: ${stats.avgReworkPerDoneCard.toFixed(2)}.`
  ].join("\n");
}

function triggerLine(trigger) {
  if (trigger.reason === "interval") {
    return `Triggered: ${trigger.doneDelta} cards reached done since the last flow-health review (threshold reached).`;
  }
  return `Triggered: rework rate ${percent(trigger.reworkRate)} over the last ${trigger.reworkSample} validation notes (threshold crossed).`;
}

function title(stats, trigger, dateStr) {
  if (trigger.reason === "interval") {
    return `Flow health: ${trigger.doneDelta} cards completed since last review (auto-proposed ${dateStr})`;
  }
  return `Flow health: rework rate ${percent(trigger.reworkRate)} over ${trigger.reworkSample} validations (auto-proposed ${dateStr})`;
}

/**
 * Turns computed flow stats + which trigger condition fired into a normal card's fields --
 * `status: "backlog"` and `agent: null` always, so this never auto-runs and never guesses whose
 * domain the fix belongs to (see docs/design/flow-stats-self-improvement.md). Pure function, no
 * I/O; `cardCreation.js`'s `createCard` is what actually writes it.
 */
export function draftImprovementCard({ stats, trigger, now = () => new Date() }) {
  const dateStr = now().toISOString().slice(0, 10);
  const marker = `<!-- flow-stats-self-improve: baseline-done=${stats.byStatus.done} -->`;

  const body = [
    marker,
    "",
    contextSection(stats),
    "",
    triggerLine(trigger),
    "",
    "## Acceptance",
    "",
    "- [ ] Root cause identified for the flow signal above (cite specific card ids and FAIL/Blocked note text, not just the aggregate numbers)",
    "- [ ] At least one concrete infra fix implemented (grant fix, prompt fix, guard fix, or similar) addressing the identified cause",
    "- [ ] A following flow-stats snapshot shows the number moved, or this card documents why improvement isn't yet measurable"
  ].join("\n");

  return {
    title: title(stats, trigger, dateStr),
    status: "backlog",
    priority: "P2",
    phase: 0,
    agent: null,
    depends_on: [],
    deliverable_type: "code",
    body
  };
}
