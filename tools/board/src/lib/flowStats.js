export const STATUS_KEYS = [
  "backlog",
  "ready",
  "in-progress",
  "validation",
  "review",
  "done",
  "blocked",
  "retired"
];

const FAIL_NOTE_RE = /^## Validation: FAIL \(/gm;
const PASS_NOTE_RE = /^## Validation: PASS \(/gm;
const RECOVERED_NOTE_RE = /^## Recovered \(/gm;
const RETRY_CAP_TEXT_RE = /Auto-retry limit reached/;

function countMatches(text, re) {
  return (text.match(re) ?? []).length;
}

/**
 * Aggregates flow-health signals purely from the existing card corpus (`store.list()`'s
 * output) -- current `status`, and the timestamped `## <heading> (<ts>)` notes
 * `runOrchestrator.js`'s `appendNote` already writes on every validation/recovery event. No new
 * persisted transition log, no I/O of its own.
 */
export function computeFlowStats(tasks) {
  const byStatus = Object.fromEntries(STATUS_KEYS.map((key) => [key, 0]));
  let reworkTotal = 0;
  let passTotal = 0;
  let recoveredTotal = 0;
  let retryCapBlockedCount = 0;
  let doneReworkTotal = 0;

  for (const task of tasks) {
    if (task.status in byStatus) {
      byStatus[task.status] += 1;
    }

    const body = task.body ?? "";
    const failCount = countMatches(body, FAIL_NOTE_RE);
    const passCount = countMatches(body, PASS_NOTE_RE);

    reworkTotal += failCount;
    passTotal += passCount;
    recoveredTotal += countMatches(body, RECOVERED_NOTE_RE);

    if (task.status === "done") {
      doneReworkTotal += failCount;
    }
    if (task.status === "blocked" && RETRY_CAP_TEXT_RE.test(body)) {
      retryCapBlockedCount += 1;
    }
  }

  const reworkSample = reworkTotal + passTotal;

  return {
    totalCards: tasks.length,
    byStatus,
    reworkTotal,
    passTotal,
    reworkSample,
    reworkRate: reworkSample > 0 ? reworkTotal / reworkSample : 0,
    recoveredTotal,
    retryCapBlockedCount,
    avgReworkPerDoneCard: byStatus.done > 0 ? doneReworkTotal / byStatus.done : 0
  };
}
