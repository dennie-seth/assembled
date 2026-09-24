import { CLAUDE_DIR_DENIAL_REASON } from "./toolAllowlist.js";

/**
 * The single definition (T-0409) of "structurally unsatisfiable by the running agent": an
 * acceptance item no action available to the running implementer, in the phase it runs, can ever
 * make true -- not merely hard, not merely unattempted. Two real cards were judged oppositely on
 * this exact shape within days: T-0405's `.claude/**` edit criterion FAILed a card twice (plus an
 * auto-spawned, since-retired escalation stub); T-0403's card-body criterion was waved through as
 * "met in substance." Both readings are defensible alone -- having both is the bug.
 *
 * `impossibleAcceptancePreflight.js` (warn-only, pre-launch) and `reviewerPrompt.js` (the
 * reviewer's own audit) both read this module rather than encoding their own copy of the class, so
 * a new member only ever needs to be added here. Each detector returns `{reason, owner}` or `null`;
 * `owner` names who *can* satisfy the item -- "planner" (the phase that owns card-body authorship
 * in db mode), "human" (a `.claude/**` edit, or a merge -- outside any unattended run entirely), or
 * "board" (the orchestrator's own PASS handler, for push/PR/CI).
 *
 * Deliberately narrow per detector, mirroring capabilityPreflight.js's own stated philosophy (its
 * RUN_CUE_RE/COMFY_CONTEXT_RE gates): an over-eager match here doesn't just mis-warn, it lets a
 * reviewer wave through an item that was actually just unmet. See this file's own test suite for
 * the "ordinary unmet item, however worded" negative cases this is tuned against.
 */

// Class 2 (T-0405): a `.claude/` path named alongside a cue that this run must itself change it.
// The harness's sensitive-file protection blocks every Edit/Write under `.claude/` in an
// unattended run regardless of the agent or its grants (toolAllowlist.js's CLAUDE_DIR_DENIAL_REASON,
// T-0374's own seven denied mechanisms) -- so this fires the same way for every agent, including
// one (like `infra`) whose nominal path scope names `.claude/**` as in-scope.
const CLAUDE_PATH_RE = /`(\.claude\/[^`]+)`/g;
const EDIT_CUE_RE =
  /\b(?:edit(?:s|ed|ing)?|updat(?:e|es|ed|ing)|modif(?:y|ies|ied|ying)|chang(?:e|es|ed|ing)|add(?:s|ed|ing)?|creat(?:e|es|ed|ing)|writ(?:e|es|ing)|written|rewrit(?:e|es|ing)|rewritten|extend(?:s|ed|ing)?)\b/i;

function detectClaudeDirEdit(text) {
  CLAUDE_PATH_RE.lastIndex = 0;
  const paths = [];
  let match;
  while ((match = CLAUDE_PATH_RE.exec(text))) {
    paths.push(match[1]);
  }
  if (paths.length === 0 || !EDIT_CUE_RE.test(text)) {
    return null;
  }
  return {
    reason:
      `names ${paths.map((p) => `\`${p}\``).join(" and ")} as something this run must itself edit or create -- ` +
      `${CLAUDE_DIR_DENIAL_REASON}`,
    owner: "human"
  };
}

// Class 1 (T-0403): a criterion demanding content live in the card's OWN body, when the running
// agent is an implementer in db mode. materializePlannerFileView (runOrchestrator.js) only ever
// exports every card to a real `tasks/<id>.md` file during the planner phase -- an implementer
// gets no such file and no board-write grant to edit the body directly, so it structurally cannot
// author into its own card. The identical wording is an ordinary, satisfiable criterion in fs mode
// (the file genuinely exists) and for the planner agent itself (it holds the file view) -- this
// keys on the running agent and task-store mode, never on the wording alone.
const CARD_BODY_RE = /\b(?:the\s+|this\s+)?card(?:'s)?\s+(?:own\s+)?body\b|\bbody\s+of\s+(?:the\s+|this\s+)?card\b/i;

function detectCardBodyAuthorship(text, ctx = {}) {
  if (ctx.taskStoreKind !== "db") return null;
  if (ctx.agentName === "planner") return null;
  if (!CARD_BODY_RE.test(text)) return null;
  return {
    reason:
      "requires content to exist in this card's own body, but in db mode a card body is only " +
      "materialized to a worktree file during the planner phase (materializePlannerFileView, " +
      "runOrchestrator.js) -- the running implementer has no card file to edit and no board-write " +
      "grant to edit the body directly",
    owner: "planner"
  };
}

// Class 3 (T-0384, T-0365, T-0258, T-0222): a pushed-remote / PR-body / CI-green requirement.
// push/PR-open happen only inside the orchestrator's own PASS handler (see runOrchestrator.js's
// _handlePass and .claude/rules/conduct.md) -- never something true before PASS is reached, so a
// criterion requiring one of them as a PASS precondition is always a deadlock. Active- and
// passive-voice forms are both covered; capabilityPreflight.js's FORBIDDEN_ACTIONS already hard-
// blocks a card at launch for the exact active-voice phrasings, so this class is what actually
// still reaches a running reviewer -- the passive-voice/circularity phrasings that hard-block
// doesn't catch (T-0258's "a PR is opened with CI green").
export const ORCHESTRATOR_ONLY_ACTION_PATTERNS = [
  {
    re: /\bopen(?:s|ed|ing)?\s+(?:a\s+|an\s+)?(?:github\s+)?pull\s*request\b/i,
    reason: "opening a pull request happens only inside the PASS handler -- it cannot be true before PASS is reached",
    owner: "board"
  },
  {
    re: /\bopen(?:s|ed|ing)?\s+(?:a\s+|an\s+)?pr\b/i,
    reason: "opening a PR happens only inside the PASS handler -- it cannot be true before PASS is reached",
    owner: "board"
  },
  {
    re: /\bpr\s+is\s+open(?:ed)?\b/i,
    reason: "a PR being open is not achievable before PASS -- push/PR-open happen only inside the PASS handler",
    owner: "board"
  },
  {
    re: /\bpull\s*request\s+is\s+open(?:ed)?\b/i,
    reason: "a pull request being open is not achievable before PASS -- push/PR-open happen only inside the PASS handler",
    owner: "board"
  },
  {
    re: /\bci\s+(?:is\s+)?green\b/i,
    reason: "CI status on a PR cannot be observed before PASS -- the PR does not exist yet at that point",
    owner: "board"
  },
  {
    re: /\bbranch\s+is\s+pushed\b/i,
    reason: "the feature branch being pushed is not achievable before PASS -- push happens only inside the PASS handler",
    owner: "board"
  },
  {
    re: /\bpush(?:es|ed|ing)?\s+(?:the\s+|this\s+)?(?:feature\s+)?branch\b/i,
    reason: "pushing the branch happens only inside the PASS handler -- it cannot be true before PASS is reached",
    owner: "board"
  },
  {
    re: /\bmerge(?:s|d|ing)?\s+(?:the\s+|this\s+)?(?:pr|pull\s*request)\b/i,
    reason: "merging is a human-only action after a card reaches done -- never something a PASS-gating criterion can require",
    owner: "human"
  },
  {
    re: /\b(?:pr|pull\s*request)\s+is\s+merged\b/i,
    reason: "merging is a human-only action after a card reaches done -- never something a PASS-gating criterion can require",
    owner: "human"
  }
];

function detectOrchestratorOnlyAction(text) {
  for (const { re, reason, owner } of ORCHESTRATOR_ONLY_ACTION_PATTERNS) {
    if (re.test(text)) {
      return { reason, owner };
    }
  }
  return null;
}

/**
 * The registry both call sites iterate. Adding a fourth member is a one-line addition here, never
 * a change at `impossibleAcceptancePreflight.js` or `reviewerPrompt.js`'s own call sites.
 */
const STRUCTURAL_UNSATISFIABILITY_CLASSES = [
  { id: "claude-dir-edit", detect: detectClaudeDirEdit },
  { id: "card-body-authorship", detect: detectCardBodyAuthorship },
  { id: "orchestrator-only-action", detect: (text) => detectOrchestratorOnlyAction(text) }
];

/**
 * Classifies a single acceptance-item's text against the registry above. `ctx` is evaluated fresh
 * on every call -- callers must not cache a classification across rounds/attempts, since a grant
 * added or a file now present can turn a previously-unsatisfiable item into an ordinary one (and
 * vice versa).
 *
 * @param {string} text - one acceptance criterion's text (parseAcceptanceCriteria's `.text`)
 * @param {{agentName?: string, taskStoreKind?: string}} ctx
 * @returns {{classId: string, reason: string, owner: "planner"|"human"|"board"}|null}
 */
export function classifyAcceptanceItem(text, ctx = {}) {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  for (const cls of STRUCTURAL_UNSATISFIABILITY_CLASSES) {
    const hit = cls.detect(text, ctx);
    if (hit) {
      return { classId: cls.id, reason: hit.reason, owner: hit.owner };
    }
  }
  return null;
}

/** Classifies a whole `parseAcceptanceCriteria` result, attaching `.classification` (or null) to each item. */
export function classifyAcceptanceItems(items, ctx = {}) {
  return items.map((item) => ({ ...item, classification: classifyAcceptanceItem(item.text, ctx) }));
}
