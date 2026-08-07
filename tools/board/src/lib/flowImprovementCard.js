const MARKER_RE = /<!-- flow-stats-self-improve: baseline-done=(\d+)(?: proposed-at=(\S+))? -->/;

/** True iff a task's body carries the auto-proposal marker this module writes -- used for de-dupe (see selfImprovementTrigger.js). */
export function isAutoProposedCard(task) {
  const body = task && task.body;
  return typeof body === "string" && MARKER_RE.test(body);
}

/** Returns the `done` count recorded as this card's baseline, or null if the card carries no marker. */
export function extractBaselineDone(body) {
  const match = MARKER_RE.exec(body ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * Returns the timestamp this card was proposed at, or null if the card carries no marker or
 * carries a legacy marker written before the weekly-cadence gate added this field.
 */
export function extractProposedAt(body) {
  const match = MARKER_RE.exec(body ?? "");
  return match && match[2] ? new Date(match[2]) : null;
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
  if (trigger.reason === "rework-rate") {
    return `Triggered: rework rate ${percent(trigger.reworkRate)} over the last ${trigger.reworkSample} validation notes (threshold crossed).`;
  }
  if (trigger.reason === "retry-cap-blocked") {
    return `Triggered: ${trigger.retryCapBlockedCount} cards blocked after exhausting the auto-retry cap (threshold crossed).`;
  }
  return `Triggered: ${trigger.recoveredTotal} orphan-reaper recoveries recorded (threshold crossed).`;
}

function title(trigger, dateStr) {
  if (trigger.reason === "rework-rate") {
    return `Flow health: rework rate ${percent(trigger.reworkRate)} over ${trigger.reworkSample} validations (auto-proposed ${dateStr})`;
  }
  if (trigger.reason === "retry-cap-blocked") {
    return `Flow health: ${trigger.retryCapBlockedCount} cards blocked on retry-cap exhaustion (auto-proposed ${dateStr})`;
  }
  return `Flow health: ${trigger.recoveredTotal} orphan-reaper recoveries (auto-proposed ${dateStr})`;
}

/** Cites the specific cards + time window backing the trigger, not just the aggregate numbers. */
function evidenceSection(trigger) {
  if (!trigger.evidence || trigger.evidence.length === 0) return null;
  const rows = trigger.evidence.map((e) => `- ${e.id}${e.timestamp ? ` (${e.timestamp})` : ""}`);
  const lines = ["## Evidence", ""];
  if (trigger.windowStart && trigger.windowEnd) {
    lines.push(`Window: ${trigger.windowStart} to ${trigger.windowEnd}.`, "");
  }
  lines.push(...rows);
  return lines.join("\n");
}

/**
 * A concrete next step tailored to the reason this fired, so the card gives the implementer a
 * lead instead of just a number -- still phrased as an investigation prompt (deterministic code
 * cannot claim to know the actual root cause), not a fabricated diagnosis.
 */
function directionLine(trigger) {
  if (trigger.reason === "rework-rate") {
    return "Suggested direction: read the FAIL notes on the cards listed under Evidence for a shared root cause (a recurring guard, grant, or lint failure is the common pattern in this codebase) and land one infra fix that removes it.";
  }
  if (trigger.reason === "retry-cap-blocked") {
    return "Suggested direction: each card listed under Evidence exhausted the auto-retry cap -- check for a shared blocking condition (permission grant, diff guard, flaky test) across them before assuming each is a one-off.";
  }
  return "Suggested direction: repeated orphan-reaper recoveries usually point at a hang or crash pattern in the runner/CLI invocation -- check the recovered cards' run logs under Evidence for a common failure point.";
}

/**
 * Turns computed flow stats + which trigger condition fired into a normal card's fields --
 * `status: "backlog"` and `agent: null` always, so this never auto-runs and never guesses whose
 * domain the fix belongs to (see docs/design/flow-stats-self-improvement.md). Pure function, no
 * I/O; `cardCreation.js`'s `createCard` is what actually writes it.
 */
export function draftImprovementCard({ stats, trigger, now = () => new Date() }) {
  const nowValue = now();
  const dateStr = nowValue.toISOString().slice(0, 10);
  const marker = `<!-- flow-stats-self-improve: baseline-done=${stats.byStatus.done} proposed-at=${nowValue.toISOString()} -->`;

  const body = [
    marker,
    "",
    contextSection(stats),
    "",
    triggerLine(trigger),
    "",
    evidenceSection(trigger),
    "",
    directionLine(trigger),
    "",
    "## Acceptance",
    "",
    "- [ ] Root cause identified for the flow signal above (cite specific card ids and FAIL/Blocked note text, not just the aggregate numbers)",
    "- [ ] At least one concrete infra fix implemented (grant fix, prompt fix, guard fix, or similar) addressing the identified cause",
    "- [ ] A following flow-stats snapshot shows the number moved, or this card documents why improvement isn't yet measurable"
  ]
    .filter((line) => line !== null)
    .join("\n");

  return {
    title: title(trigger, dateStr),
    status: "backlog",
    priority: "P2",
    phase: 0,
    agent: null,
    depends_on: [],
    deliverable_type: "code",
    body
  };
}
