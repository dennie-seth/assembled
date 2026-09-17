import fs from "node:fs";
import { parseAcceptanceCriteria } from "../lib/acceptanceCriteria.js";
import { resolveAllowedTools } from "./toolAllowlist.js";
import { extractBashPrefixes } from "./capabilityPreflight.js";
import { listSourceIds } from "../lib/referenceSourcePolicy.js";

// Case 3 of the three-way rule (T-0300): a criterion phrased so that only a human's own sensory
// report can satisfy it -- no test, log, or grant makes it agent-checkable, regardless of who runs
// it. T-0288's literal wording ("say what you observed ... do not infer it from the code") and
// docs/browser-tests.md's own retrospective naming of the same failure shape are the ground truth
// here. Deliberately specific multi-word phrases, not single words like "verify"/"confirm" --
// planner.md already warns that a single common word cries wolf on plenty of satisfiable criteria.
const HUMAN_OBSERVATION_PATTERNS = [
  {
    re: /\bsay what you observed\b/i,
    label: "demands the agent's own sensory observation, not an inference from code or tests"
  },
  {
    re: /\bdo not infer\b[^.]*\bfrom the code\b/i,
    label:
      "explicitly forbids inferring the result from the code -- only a human watching it happen can satisfy this"
  },
  {
    re: /\bverify(?:ing)?\s+by\s+looking\b/i,
    label: "requires visually looking at the result, not a runnable check"
  },
  {
    re: /\bconfirm(?:ing|ed)?\s+visually\b/i,
    label: "requires visual confirmation, not a runnable check"
  },
  {
    re: /\bobserve[sd]?\s+(?:it|this|the\s+\S+)\s+in\s+a\s+(?:real\s+)?browser\b/i,
    label: "requires observing behavior in a real, human-watched browser"
  },
  {
    re: /\bthe felt behavior\b/i,
    label: "asks for the subjective 'felt' behavior, which only a human can report"
  }
];

// Case 4 (never allowed to reach a card's ## Acceptance at all): push/PR-open/merge happen only
// inside the orchestrator's PASS handler (see runOrchestrator.js's _handlePass and
// .claude/rules/conduct.md), so a criterion requiring any of them as a PASS precondition is always
// a deadlock. capabilityPreflight.js's FORBIDDEN_ACTIONS already hard-blocks the active-voice forms
// ("open a PR", "push the branch"); this list adds the passive-voice forms that shape has missed in
// practice (T-0258's "a PR is opened with CI green") and is deliberately redundant with that
// hard-block on the active-voice forms too, since this module's own job is to be tested directly
// against all six real fixture cases, independent of which other check also happens to catch one.
const PR_CI_CIRCULARITY_PATTERNS = [
  {
    re: /\bopen(?:s|ed|ing)?\s+(?:a\s+|an\s+)?(?:github\s+)?pull\s*request\b/i,
    label: "opening a pull request happens only inside the PASS handler -- it cannot be true before PASS is reached"
  },
  {
    re: /\bopen(?:s|ed|ing)?\s+(?:a\s+|an\s+)?pr\b/i,
    label: "opening a PR happens only inside the PASS handler -- it cannot be true before PASS is reached"
  },
  {
    re: /\bpr\s+is\s+open(?:ed)?\b/i,
    label: "a PR being open is not achievable before PASS -- push/PR-open happen only inside the PASS handler"
  },
  {
    re: /\bpull\s*request\s+is\s+open(?:ed)?\b/i,
    label: "a pull request being open is not achievable before PASS -- push/PR-open happen only inside the PASS handler"
  },
  {
    re: /\bci\s+(?:is\s+)?green\b/i,
    label: "CI status on a PR cannot be observed before PASS -- the PR does not exist yet at that point"
  },
  {
    re: /\bbranch\s+is\s+pushed\b/i,
    label: "the feature branch being pushed is not achievable before PASS -- push happens only inside the PASS handler"
  },
  {
    re: /\bmerge(?:s|d|ing)?\s+(?:the\s+|this\s+)?(?:pr|pull\s*request)\b/i,
    label: "merging is a human-only action after a card reaches done -- never something a PASS-gating criterion can require"
  }
];

// Case 4 continued: the T-0233 shape (`docs/board-invariants.md` §10, `.claude/rules/conduct.md`'s
// requires_approval rule). An agent parking a `requires_approval` card must never write its own
// approval record -- so a criterion phrased as a named human (or "a human") approving something is
// never a thing an agent can make true of itself.
const APPROVAL_CIRCULARITY_PATTERNS = [
  {
    re: /@[\w-]+\s+approves?\b/i,
    label: "a named human's approval is not something any agent can grant itself (see .claude/rules/conduct.md's requires_approval rule)"
  },
  {
    re: /\bis\s+approved\s+by\b/i,
    label: "approval-by-human is not agent-checkable before a human actually acts"
  },
  {
    re: /\bhuman\s+approves?\b/i,
    label: "approval-by-human is not agent-checkable before a human actually acts"
  }
];

// Case 2/1 boundary: named operational tools no agent in this repo is ever granted, cross-checked
// against the ASSIGNED agent's own resolved grants (not a blanket "always impossible" rule) --
// T-0300's own edge case: impossible for one agent can be fine for another. Kept to a short,
// specific list (systemctl/journalctl -- T-0290's exact missing grant -- plus the browser-driver
// binaries the "browser drivers" bullet names) rather than every unknown verb, mirroring
// capabilityPreflight.js's own RUN_CUE_RE-gated command check and its stated reason for that
// narrowness: an unbounded keyword set over-triggers on ordinary prose.
const UNGRANTED_OPS_TOOLS = [
  "systemctl",
  "journalctl",
  "playwright",
  "puppeteer",
  "selenium",
  "chromedriver",
  "geckodriver",
  "webdriver"
];

// Case 2: T-0273's failure shape, generalized -- generated from referenceSourcePolicy.js's actual
// source allowlist rather than a hardcoded list, so a newly added source (T-0284's "met") is
// covered automatically. That module already encodes the real fix (required: true for wikimedia,
// false for openverse/met, T-0283/T-0284) -- this check flags a card that writes its own AC as if
// that split didn't exist, requiring every named source to succeed at once.
const SOURCE_MENTION_PATTERNS = {
  wikimedia: /\bwikimedia\b/i,
  openverse: /\bopenverse\b/i,
  met: /\bthe met\b|\bmetropolitan\b/i
};
const REQUIRE_ALL_CUE_RE = /\b(?:both|all)\b/i;
const AT_LEAST_ONE_CUE_RE = /\bat least one\b|\bbest-effort\b|\beither\b/i;

function sourceMentionRe(sourceId) {
  return SOURCE_MENTION_PATTERNS[sourceId] ?? new RegExp(`\\b${sourceId}\\b`, "i");
}

/**
 * Warn-only pre-flight (T-0300) for the "unsatisfiable acceptance criterion" class documented in
 * docs/reviews/2026-09-03-run-lifecycle-state-management.md §4.0b: a criterion no agent can ever
 * satisfy reproduces an identical failure signature on every retry, which the no-progress guard
 * (§23-a) then correctly aborts -- the guard is working, the card was unrunnable from the start.
 *
 * Unlike acceptancePreflight.js and capabilityPreflight.js, this NEVER blocks. A false positive
 * here must never stop a legitimate card from running (T-0300's own explicit acceptance criterion)
 * -- the four categories below are heuristics over freeform English, not a grant lookup with a
 * definite yes/no answer, so they are surfaced as a warning (card comment + run log, wired in
 * runOrchestrator.js) for a human to read, never as a `_blocked` reason.
 *
 * Returns `{ warnings: string[] }` -- deliberately not the `{ok, message}` shape the other two
 * preflights use, since that shape signals "may block" and this one structurally cannot.
 */
export function checkImpossibleAcceptancePreflight(
  task,
  agentName,
  { agentsDir = ".claude/agents", readFileFn = fs.readFileSync, resolveAllowedToolsFn = resolveAllowedTools } = {}
) {
  const items = parseAcceptanceCriteria(task?.body ?? "");
  if (items.length === 0) {
    // A missing/unparseable Acceptance section is acceptancePreflight.js's job, not this one's.
    return { warnings: [] };
  }

  const allowedTools = resolveAllowedToolsFn(agentName, { agentsDir, readFileFn });
  const grantedFirstWords = new Set(
    extractBashPrefixes(allowedTools)
      .map((prefix) => prefix.trim().split(/\s+/)[0])
      .filter(Boolean)
  );

  const warnings = [];
  const seen = new Set();
  const addWarning = (text, reason) => {
    const message = `AC item "${text}" ${reason}.`;
    if (seen.has(message)) return;
    seen.add(message);
    warnings.push(message);
  };

  for (const { text } of items) {
    for (const { re, label } of HUMAN_OBSERVATION_PATTERNS) {
      if (re.test(text)) addWarning(text, label);
    }
    for (const { re, label } of PR_CI_CIRCULARITY_PATTERNS) {
      if (re.test(text)) addWarning(text, label);
    }
    for (const { re, label } of APPROVAL_CIRCULARITY_PATTERNS) {
      if (re.test(text)) addWarning(text, label);
    }
    for (const toolName of UNGRANTED_OPS_TOOLS) {
      if (new RegExp(`\\b${toolName}\\b`, "i").test(text) && !grantedFirstWords.has(toolName)) {
        addWarning(
          text,
          `names \`${toolName}\`, which agent "${agentName}" has no Bash grant covering ` +
            `(checked ${agentsDir}/${agentName}.md)`
        );
      }
    }

    const mentionedSources = listSourceIds().filter((sourceId) => sourceMentionRe(sourceId).test(text));
    if (mentionedSources.length >= 2 && REQUIRE_ALL_CUE_RE.test(text) && !AT_LEAST_ONE_CUE_RE.test(text)) {
      addWarning(
        text,
        `requires all of ${mentionedSources.join(", ")} to succeed -- upstream reference sources are ` +
          `known to rate-limit/timeout independently (see referenceSourcePolicy.js's required/best-effort ` +
          `split); phrase as "at least one succeeds" instead`
      );
    }
  }

  return { warnings };
}
