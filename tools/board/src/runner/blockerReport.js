/**
 * The six ways a card's auto-retry exhaustion is categorized (docs/design/escalation-workflow.md).
 * Order is significant for `categorizeFailure`: earlier categories are checked first, so a note
 * mentioning both a permission issue and an incidental "tool" word still lands on the more
 * specific match.
 */
export const BLOCKER_CATEGORIES = [
  "permission-grant",
  "tool",
  "env-dependency",
  "external-service",
  "design-ambiguity",
  "code-test-bug"
];

const CATEGORY_PATTERNS = [
  { category: "permission-grant", re: /permission denied|not allowed|forbidden|\b403\b|EACCES|no grant|not authorized|access denied/i },
  { category: "tool", re: /tool not (?:available|found)|unknown tool|command not found|missing tool|not permitted to use/i },
  { category: "env-dependency", re: /ENOENT|module not found|cannot find module|not installed|missing dependency|package not found/i },
  {
    category: "external-service",
    re: /ECONNREFUSED|ETIMEDOUT|timed? ?out|network error|service unavailable|\b502\b|\b503\b|connection refused|fetch failed/i
  },
  { category: "design-ambiguity", re: /ambiguous|underspecified|unclear (?:spec|requirement)|not specified|conflicting requirement/i }
];

const CATEGORY_LABELS = {
  "permission-grant": "Permission/grant",
  tool: "Tool",
  "env-dependency": "Environment/dependency",
  "external-service": "External service",
  "design-ambiguity": "Design ambiguity",
  "code-test-bug": "Code/test bug"
};

/** Heuristically categorizes a block of FAIL-note text into one of BLOCKER_CATEGORIES, defaulting to "code-test-bug". */
export function categorizeFailure(text) {
  for (const { category, re } of CATEGORY_PATTERNS) {
    if (re.test(text)) return category;
  }
  return "code-test-bug";
}

/**
 * Deterministically assembles a structured blocker report from the reviewer FAIL verdicts the
 * card actually accumulated across its exhausted auto-retry attempts -- no extra LLM call, since
 * that text is already genuine agent output describing what was attempted and why it failed (see
 * docs/design/escalation-workflow.md for why this doesn't spawn a 6th `claude` process).
 *
 * `noProgress`/`repeatedSignature` (§23-a): set when escalation fired because two consecutive
 * attempts hashed to the identical failure signature (see failureSignature.js), not because the
 * auto-retry cap was exhausted. `abortReason` names which of the two happened, and includes the
 * repeated signature's hash when it's the no-progress case -- both the appended comment
 * (formatBlockerReportComment) and the remediation card (escalationRemediation.js) surface it, so
 * neither reads as "gave up after 5 tries" when the loop actually stopped itself early.
 */
export function buildBlockerReport({ task, attemptRecords, attemptCount, noProgress = false, repeatedSignature = null }) {
  const count = attemptCount ?? attemptRecords.length;
  const branch = task.branch ?? `feature/${task.id}`;
  const attempted = `Attempted ${task.id} (${task.title}) across ${count} implementer/reviewer cycles on branch ${branch}.`;
  const failureSignature = attemptRecords.map((r) => `Run ${r.attempt} of ${count}: ${r.notes}`).join("\n");
  const combinedText = attemptRecords.map((r) => r.notes).join("\n");
  const category = categorizeFailure(combinedText);
  const detail = attemptRecords.length > 0 ? attemptRecords[attemptRecords.length - 1].notes : "";
  const abortReason = noProgress
    ? `Retry loop aborted for no progress: the last two consecutive attempts failed with the identical failure signature \`${repeatedSignature}\` -- not because attempts were exhausted.`
    : `Retry loop aborted after exhausting all ${count} auto-retry attempts.`;

  return { attempted, failureSignature, lacks: { category, detail }, noProgress, repeatedSignature, abortReason };
}

/** Renders a blocker report as the markdown comment body appended to the blocked card. */
export function formatBlockerReportComment(report) {
  const label = CATEGORY_LABELS[report.lacks.category] ?? report.lacks.category;
  const heading = report.noProgress ? "## Blocker report (no progress — retry loop aborted)" : "## Blocker report (auto-retry exhausted)";
  const lines = [heading, "", `**Attempted:** ${report.attempted}`, ""];
  if (report.abortReason) {
    lines.push(`**Abort reason:** ${report.abortReason}`, "");
  }
  lines.push(
    "**Failure signature across attempts:**",
    "",
    report.failureSignature,
    "",
    `**Lacks:** ${label} — ${report.lacks.detail}`
  );
  return lines.join("\n");
}
