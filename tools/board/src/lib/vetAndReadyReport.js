/**
 * Renders a `vetAndReady()` result and poller state into the morning summary text T-0384's
 * acceptance criteria ask for: printed to stdout (so `journalctl --user -u <unit>` has it, since
 * systemd captures a unit's own stdout into the journal automatically -- no `journalctl` call
 * needed from this code) and written to a file the operator can read later.
 */

const READY_LABEL = "READIED";
const SKIP_LABEL = "skipped";

/** One line per card: id, title, priority, verdict, the rule that decided it, and its evidence. */
export function formatDecisionRow(entry) {
  const label = entry.verdict === "ready" ? READY_LABEL : SKIP_LABEL;
  const evidence = entry.evidence ? ` (${entry.evidence})` : "";
  const title = entry.title ? ` "${entry.title}"` : "";
  return `- ${entry.id}${title} [${entry.priority}] ${label} -- ${entry.rule}: ${entry.reason}${evidence}`;
}

/**
 * T-0425: one indented line per reason on every acceptance-authoring flag attached to a decision
 * entry (vetAndReady.js's `acceptanceFlags`) -- so the flag lands where a human actually reads the
 * morning summary (this report, hence `latest.md`), attributed to its own criterion, rather than
 * only in a log line. Empty/missing `acceptanceFlags` renders nothing, which is the common case.
 */
export function formatAcceptanceFlagLines(entry) {
  const flags = entry.acceptanceFlags ?? [];
  const lines = [];
  for (const flag of flags) {
    const label = flag.text ? `"${flag.text}"` : "(no ## Acceptance section)";
    for (const reason of flag.reasons) {
      lines.push(`    - acceptance-authoring flag ${label}: ${reason}`);
    }
  }
  return lines;
}

/** The full per-card decision table, readied cards listed before skipped ones. */
export function formatDecisionTable(result) {
  const lines = [
    `Eligible-at-all: ${result.eligibleCount} card(s) (status=backlog, agent=infra, deliverable_type=code, requires_approval=false)`,
    `Readied: ${result.readied.length} (cap ${result.cap})`,
    `Skipped: ${result.skipped.length}`
  ];

  const renderGroup = (entries) => entries.flatMap((entry) => [formatDecisionRow(entry), ...formatAcceptanceFlagLines(entry)]);

  if (result.readied.length > 0) {
    lines.push("", "## Readied", ...renderGroup(result.readied));
  }
  if (result.skipped.length > 0) {
    lines.push("", "## Skipped", ...renderGroup(result.skipped));
  }
  return lines.join("\n");
}

/**
 * Reports whether the auto-launch poller is enabled, its interval and its usage cap. Degrades
 * gracefully (never throws) when `GET /api/poller` (T-0383) isn't available on this board
 * deployment yet, or wasn't reachable at all -- `poller.available === false` either way, with
 * `poller.note` explaining why.
 */
export function formatPollerSummary(poller) {
  if (!poller || poller.available === false) {
    return `Poller state: unavailable -- ${poller?.note ?? "GET /api/poller did not respond"}`;
  }
  const { enabled, intervalMs, usageMax } = poller;
  const intervalHuman = typeof intervalMs === "number" ? `${Math.round(intervalMs / 60000)}m` : "unknown";
  return `Poller state: enabled=${enabled ?? "unknown"}, interval=${intervalHuman}, usageMax=${usageMax ?? "unknown"}`;
}

/** Stitches the run timestamp, poller summary, decision table, and (if given) an apply summary. */
export function formatReport({ result, poller, timestamp, appliedSummary }) {
  const lines = [`# Board vet-and-ready run -- ${timestamp}`, "", formatPollerSummary(poller), "", formatDecisionTable(result)];
  if (appliedSummary) {
    lines.push("", "## Apply", appliedSummary);
  }
  return lines.join("\n");
}
