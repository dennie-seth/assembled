import { parseHostActionRequest } from "../lib/hostActionRequest.js";
import { CLAUDE_DIR_DENIAL_REASON, CLAUDE_DIR_BASH_DENIAL_REASON } from "./toolAllowlist.js";

/**
 * The seven ways a card's auto-retry exhaustion is categorized (docs/design/escalation-workflow.md,
 * docs/design/host-action-escalation.md). Order is significant for `categorizeFailure`: earlier
 * categories are checked first, so a note mentioning both a permission issue and an incidental
 * "tool" word still lands on the more specific match. `host-action` wins first via a *structural*
 * check (a fenced host-action-request block, see .claude/rules/conduct.md for the format every
 * agent is taught) before `categorizeFailure` even reaches the keyword table below -- a structural
 * match always beats a guess. `host-action` also has a *prose* fallback as the keyword table's
 * first entry (T-0323), for a diagnosis that names a host-only wall but never got wrapped in the
 * fenced block -- exactly the failure mode that produced the T-0321 misclassification.
 *
 * T-0412: the CLI's own `.claude/` sensitive-file denial (`CLAUDE_DIR_DENIAL_REASON`) and the
 * board's matching Bash-write denial (`CLAUDE_DIR_BASH_DENIAL_REASON`, T-0411) are checked by
 * literal containment, not a keyword guess, the same way the structural host-action check above
 * is -- both denial strings live in `toolAllowlist.js` precisely so this file never duplicates or
 * drifts from their exact wording. Before this, a FAIL note quoting either denial verbatim fell
 * through every pattern below and defaulted to "code-test-bug", mislabeling the blocker report
 * and remediation card text for a card that had already stopped.
 *
 * T-0412 round 2 correction: this fix changes what the escalation report *says*, never whether or
 * when a card stops retrying, and never which agent a remediation card is routed to.
 * `categorizeFailure` is reached only from `buildBlockerReport`, itself called only from
 * `_escalateIfGenuineBlocker` in runOrchestrator.js -- which runs only after `stopping`
 * (`isFinalAttempt || noProgress`) is already true, i.e. after the retry loop has already finished
 * on its own. By the time this function ever sees a FAIL note, every retry that was going to happen
 * already has. `draftRemediationCard` (escalationRemediation.js) also sets `agent: "dispatch"`
 * unconditionally for every category, so the classification doesn't change routing either -- see
 * runOrchestrator.escalation.test.js's and escalationRemediation.test.js's T-0412-round-2 tests,
 * which pin both of those orderings in code. Round 1 of this card claimed the opposite (that this
 * fix lets a card "escalate instead of retrying" / "instead of burning retry attempts") -- that
 * claim was false and is retracted; see tasks/T-0412.md.
 */
export const BLOCKER_CATEGORIES = [
  "host-action",
  "permission-grant",
  "tool",
  "env-dependency",
  "external-service",
  "design-ambiguity",
  "code-test-bug"
];

const CATEGORY_PATTERNS = [
  // T-0323: a prose fallback for a host-only diagnosis that never made it into the fenced
  // ```host-action-request block (see .claude/rules/conduct.md) -- the exact T-0321 gap this
  // card exists to close: a correct diagnosis of "no shell on the host" that fell through to
  // "code-test-bug" because nothing told the writer the structured format existed. Checked
  // first among the keyword patterns so it outranks an incidental "permission denied"/"tool"
  // match elsewhere in the same notes.
  {
    category: "host-action",
    re: /\bno (?:agent )?shell\b|\bhost-only\b|\bhost-side\b|\bWindows host\b|\bno host shell\b|\brequires? (?:a )?host (?:shell|action)\b/i
  },
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
  "host-action": "Host action required",
  "permission-grant": "Permission/grant",
  tool: "Tool",
  "env-dependency": "Environment/dependency",
  "external-service": "External service",
  "design-ambiguity": "Design ambiguity",
  "code-test-bug": "Code/test bug"
};

/**
 * Categorizes a block of FAIL-note text into one of BLOCKER_CATEGORIES, defaulting to
 * "code-test-bug". A structural host-action-request block always wins over every keyword
 * heuristic below it (T-0323) -- see BLOCKER_CATEGORIES' docstring for why.
 */
export function categorizeFailure(text) {
  if (parseHostActionRequest(text)) return "host-action";
  if (typeof text === "string" && (text.includes(CLAUDE_DIR_DENIAL_REASON) || text.includes(CLAUDE_DIR_BASH_DENIAL_REASON))) {
    return "permission-grant";
  }
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
  // T-0323: a structural host-action-request match carries its parsed {host,action,reason,verify}
  // payload through so every downstream rendering can keep the fields distinct instead of folding
  // them into `detail`'s prose.
  const hostAction = category === "host-action" ? parseHostActionRequest(combinedText) : null;

  return {
    attempted,
    failureSignature,
    lacks: hostAction ? { category, detail, hostAction } : { category, detail },
    noProgress,
    repeatedSignature,
    abortReason
  };
}

/** Renders a blocker report as the markdown comment body appended to the blocked card. */
export function formatBlockerReportComment(report) {
  const label = CATEGORY_LABELS[report.lacks.category] ?? report.lacks.category;
  const heading = report.noProgress ? "## Blocker report (no progress — retry loop aborted)" : "## Blocker report (auto-retry exhausted)";
  const lines = [heading, "", `**Attempted:** ${report.attempted}`, ""];
  if (report.abortReason) {
    lines.push(`**Abort reason:** ${report.abortReason}`, "");
  }
  lines.push("**Failure signature across attempts:**", "", report.failureSignature, "");

  // T-0323: a host-action blocker renders as distinct labeled fields, never folded back into a
  // single prose sentence -- the whole point of the structured category over free text.
  if (report.lacks.hostAction) {
    const { host, action, reason, verify } = report.lacks.hostAction;
    lines.push(
      `**Lacks:** ${label} — this cannot be completed without host-side access.`,
      "",
      `**Host:** ${host}`,
      `**Action:** ${action}`,
      `**Reason:** ${reason}`,
      `**Verify:** ${verify}`
    );
  } else {
    lines.push(`**Lacks:** ${label} — ${report.lacks.detail}`);
  }

  return lines.join("\n");
}
