import { SATISFIED_DEP_STATUSES } from "../runner/autoLaunchPoller.js";
import { ACCEPTANCE_HEADING_TEXT_SRC } from "./acceptanceCriteria.js";

/**
 * The mechanical vetting rules for T-0384's nightly vet-and-ready job, ported from the external
 * (no-WSL) `nightly-infra-prep` skill. Every function here is pure/injectable -- no board API,
 * no `git`, no filesystem -- so the CLI wrapper (`tools/board/ops/vetAndReady.js`) is the only
 * place that touches real I/O and this module is fully unit-testable.
 */

/** "Eligible at all": the card types this job is ever allowed to touch. See isEligibleAtAll. */
export const ELIGIBLE_STATUS = "backlog";
export const ELIGIBLE_AGENT = "infra";
export const ELIGIBLE_DELIVERABLE_TYPE = "code";

/** Per-run cap on how many cards this job will ready in one invocation (spec rule 5). */
export const READY_CAP = 4;

/**
 * Body markers that mean a card's acceptance may be self-contradicted or superseded by a later
 * section of its own body (spec rule 3, worked example T-0339). Deliberately a fixed, documented
 * list of rules rather than an open-ended heuristic -- "each decided mechanically" -- so a marker
 * this list doesn't cover is a known limitation, not a silent gap. "and so on" in the source spec
 * is exactly why this list may need a future addition; extend it here, in one place, when it does.
 *
 * Codex review of #396, finding 1: the original implementation did a case-sensitive
 * `body.includes()` over a fixed-case string list, so `## Held`, lowercase `held`, and
 * `Stop-and-report:` all slipped through and got readied. Every pattern here is matched
 * case-insensitively, and the phrase markers tolerate the real punctuation/spacing variants
 * Codex reproduced (`stop-and-report`, `stop and report`, hyphen-optional `re-scoped`). Word-like
 * markers use `\b` boundaries so an unrelated word merely containing the marker as a substring
 * (`upheld`, `withheld`) does not false-trigger -- see the "still passes" test in
 * test/lib/vetAndReady.test.js.
 *
 * `## Finding` is its own rule: a "## Finding" (or "## Findings") heading is, on its own, a
 * recorded-outcome section per the source spec's "a stop-and-report outcome already recorded" --
 * so its mere presence is a governing signal even without one of the other phrase markers also
 * appearing in the same body (see T-0384's fix-round AC).
 */
const SUPERSEDED_MARKER_RULES = [
  { label: "HELD", test: (body) => /\bheld\b/i.test(body) },
  { label: "RE-SCOPED", test: (body) => /\bre-?scoped\b/i.test(body) },
  { label: "SUPERSEDED", test: (body) => /\bsuperseded\b/i.test(body) },
  { label: "This section governs", test: (body) => /this section governs/i.test(body) },
  { label: "STOP AND REPORT", test: (body) => /stop[\s-]+and[\s-]+report/i.test(body) },
  { label: "## Finding", test: (body) => /^\s{0,3}#{1,6}\s*findings?\b/im.test(body) }
];

/** Display labels for the rules above -- used by tests and anything that wants the marker list. */
export const SUPERSEDED_MARKERS = SUPERSEDED_MARKER_RULES.map((rule) => rule.label);

const PRIORITY_RANK = new Map([
  ["P0", 0],
  ["P1", 1],
  ["P2", 2],
  ["P3", 3]
]);
const UNRANKED_PRIORITY = Number.MAX_SAFE_INTEGER;

function priorityRank(task) {
  const rank = PRIORITY_RANK.get(task.priority);
  return rank === undefined ? UNRANKED_PRIORITY : rank;
}

/** "T-0042" -> 42, so id ordering is numeric rather than lexicographic (T-0100 before T-0021). */
function numericId(task) {
  const match = /(\d+)/.exec(task.id ?? "");
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function byIdAscending(a, b) {
  return numericId(a) - numericId(b);
}

/**
 * "Eligible at all" (spec scope): a card this job is even allowed to consider readying. Never an
 * assets/GPU card, a `dispatch` card, or anything approval-gated -- those stay in backlog
 * whatever else is true, and are never even entered into the decision table.
 */
export function isEligibleAtAll(task) {
  return (
    task.status === ELIGIBLE_STATUS &&
    task.agent === ELIGIBLE_AGENT &&
    (task.deliverable_type ?? "code") === ELIGIBLE_DELIVERABLE_TYPE &&
    task.requires_approval !== true
  );
}

/**
 * Rule 1: every dependency is `done` or `retired` -- the same satisfied test
 * `autoLaunchPoller.js`'s `selectNextCard` uses for the launch guard. A dependency id absent from
 * the corpus counts as unmet (uncertainty skips, never assumed satisfied).
 *
 * This is also what enforces rule 4 (DAG respect) for a direct edge between two cards vetted in
 * the same run: `ready` is never in `SATISFIED_DEP_STATUSES`, so a dependent card whose
 * prerequisite is only being readied this run (not yet `done`) still fails this check -- only the
 * head of a dependent pair can ever pass rule 1 and reach the cap in the same run.
 */
export function dependencyCheck(task, tasksById) {
  const deps = task.depends_on ?? [];
  const evaluated = deps.map((id) => ({ id, status: tasksById.get(id)?.status ?? null }));
  const unmet = evaluated.filter((dep) => !SATISFIED_DEP_STATUSES.has(dep.status));

  if (unmet.length === 0) {
    return { ok: true, reason: "every dependency is done or retired", evidence: JSON.stringify(evaluated) };
  }
  return {
    ok: false,
    reason: `unmet dependency: ${unmet.map((dep) => `${dep.id} is ${dep.status ?? "unknown (not found in the corpus)"}`).join(", ")}`,
    evidence: JSON.stringify(unmet)
  };
}

/** Rule 3: the card body carries none of `SUPERSEDED_MARKER_RULES`, case-insensitively. */
export function supersededCheck(task) {
  const body = task.body ?? "";
  const hits = SUPERSEDED_MARKER_RULES.filter((rule) => rule.test(body)).map((rule) => rule.label);
  if (hits.length === 0) {
    return { ok: true, reason: "no superseding/held markers found in the card body", evidence: "" };
  }
  return {
    ok: false,
    reason: `acceptance may be self-contradicted or superseded -- body contains marker(s): ${hits.join(", ")}`,
    evidence: hits.join(", ")
  };
}

/**
 * The section-heading regex `extractAcceptancePaths` scopes its extraction to.
 *
 * Reviewer FAIL round, 2026-09-18: this used to anchor with `^...$` under the `m` flag, so `$`
 * matched at the end of every LINE, not just the end of the body. This repo's own house style
 * puts a blank line right after the `## Acceptance` heading -- "## Acceptance\n\n- [ ] ..." -- and
 * that blank line satisfied `\n*$` immediately, so the capture group came back empty for
 * virtually every real card, regardless of what its acceptance section actually named. No `m`
 * flag now: `(?:^|\n)` finds the heading at the body's start or after any newline (so it still
 * doesn't require the heading to be the very first line), and a bare `$` matches only the true
 * end of the body, so the capture only stops early at an actual next heading.
 *
 * T-0405: the heading-text portion (`#{1,6}\s+` + ACCEPTANCE_HEADING_TEXT_SRC) is now imported
 * from acceptanceCriteria.js instead of defined separately here. The two used to disagree on what
 * counts as "the" Acceptance heading -- this one already tolerated any suffix, while
 * acceptanceCriteria.js's parseAcceptanceCriteria required an exact "## Acceptance" -- so a card
 * the nightly vet-and-ready job happily readied (via this regex) could be hard-blocked at run
 * preflight by that stricter one for the very same heading (T-0403, T-0396). Building both from
 * the same fragment means they can no longer drift apart; see
 * test/lib/acceptanceHeadingAgreement.test.js for the guard that pins this.
 */
const ACCEPTANCE_SECTION_RE = new RegExp(
  `(?:^|\\n)#{1,6}\\s+${ACCEPTANCE_HEADING_TEXT_SRC}[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,6}\\s|$)`,
  "i"
);
export { ACCEPTANCE_SECTION_RE };

/**
 * File extensions `extractAcceptancePaths` treats as "this token names a repo path", not just
 * "this token happens to contain a dot" (which would also match things like "e.g." or "v1.0").
 * A short, curated allowlist rather than an exhaustive one -- widening it only ever makes the
 * check MORE conservative (more candidate paths checked, more potential skips), never less safe.
 */
const PATH_TOKEN_EXTENSIONS = "js|jsx|ts|tsx|py|md|json|yml|yaml|sh|cpp|hpp|h|cc|sql|gd|toml|cfg|ini|txt";
const PATH_TOKEN_RE = new RegExp(
  "`([^`\\s]+\\.(?:" + PATH_TOKEN_EXTENSIONS + "))`" + "|" + "\\b([\\w][\\w./-]*\\.(?:" + PATH_TOKEN_EXTENSIONS + "))\\b",
  "gi"
);

/**
 * Purely mechanical: extracts path-*looking* tokens (backtick-quoted, or bare `word.ext`) from
 * the card body's own `## Acceptance` section only -- never its `Links`/`Pointers`/`Scope`
 * sections, which routinely name paths to *existing* docs unrelated to this card (`docs/PLAN.md`
 * always exists) and would otherwise make every card that links to one look "already satisfied".
 * No file content is read here and no path is required to actually exist -- this only produces
 * candidates for `mergedWorkCheck` to check for existing git history on the base branch.
 */
export function extractAcceptancePaths(body) {
  const match = ACCEPTANCE_SECTION_RE.exec(body ?? "");
  const section = match ? match[1] : "";
  const paths = new Set();
  let hit;
  const re = new RegExp(PATH_TOKEN_RE);
  while ((hit = re.exec(section))) {
    const token = hit[1] || hit[2];
    if (token) paths.add(token);
  }
  return [...paths];
}

/**
 * Rule 2: not already satisfied by merged work. Checks the base branch (`develop`) two ways,
 * both via the single injected `gitLogGrep(term)` (see `tools/board/ops/vetAndReady.js`'s
 * `makeGitLogGrep`, which runs a message `--grep` for an id-shaped term and a path-scoped
 * `git log -- <path>` for a path-shaped one) so this stays a pure function that never shells out
 * itself:
 *
 *   1. Does any commit message on `develop` mention the card id?
 *   2. Does any path named in the card's own `## Acceptance` section already have commit history
 *      on `develop` (extractAcceptancePaths above)?
 *
 * Conservative on every failure mode: EITHER check hitting is treated as "possibly already
 * satisfied" (skip), and a `git` error on any check is treated as uncertain (skip) rather than
 * either crashing the run or silently treating the card as clear.
 *
 * Codex review 2026-09-18, finding 2: check (1) alone is not enough -- an empty id-grep only
 * proves commit *messages* don't mention the id, not that the described work is actually
 * missing (Codex's fixture: `develop` already had `feature.js` implementing the card's whole
 * acceptance, committed as "Implement feature flag" with no id mention anywhere). Check (2)
 * closes that gap mechanically -- existence-on-branch, not content/prose interpretation. Neither
 * check attempts the full "does the diff match the described change" judgment call: a path
 * existing is only ever evidence to SKIP (conservative), never evidence to positively clear one
 * that wasn't already going to clear on its own.
 *
 * Reviewer FAIL round, 2026-09-18 (AC 10): an absent id-grep is still not clearance on its own --
 * it is silent precisely when the acceptance section names no checkable path at all, which is
 * exactly the case where check (2) has nothing to check. There are only three authorised
 * outcomes here: mechanical acceptance evidence (a path with no history -> ok), an explicit
 * recorded vetting decision (none exists in this corpus today), or skip-as-uncertain. So when
 * `extractAcceptancePaths` finds zero path-like tokens, ok:true is never reachable purely off an
 * absent id-grep -- this returns skip-as-uncertain instead, unless the id-grep itself hit (which
 * still means "possibly already satisfied", handled the same as before).
 */
export async function mergedWorkCheck({ task, gitLogGrep }) {
  const paths = extractAcceptancePaths(task.body);
  const candidates = [
    { term: task.id, label: `card id ${task.id}` },
    ...paths.map((p) => ({ term: p, label: `acceptance path \`${p}\`` }))
  ];

  const hits = [];
  for (const candidate of candidates) {
    let result;
    try {
      result = await gitLogGrep(candidate.term);
    } catch (err) {
      return { ok: false, reason: `could not verify merged-work status (git check failed): ${err.message}`, evidence: "" };
    }
    if (result && result.length > 0) {
      hits.push({ ...candidate, commits: result });
    }
  }

  if (hits.length > 0) {
    return {
      ok: false,
      reason: `possibly already satisfied by merged work -- develop already shows activity for ${hits.map((h) => h.label).join(", ")}`,
      evidence: hits
        .flatMap((h) => h.commits)
        .slice(0, 5)
        .join(" | ")
    };
  }

  if (paths.length === 0) {
    return {
      ok: false,
      reason:
        "uncertain -- acceptance names no checkable path, cannot mechanically confirm the work is unmerged (an absent card-id hit alone is not clearance)",
      evidence: ""
    };
  }

  return {
    ok: true,
    reason: "no develop commits mention this card id, and none of the paths its acceptance section names already have history on develop",
    evidence: ""
  };
}

/**
 * Runs every rule in order over `tasks` and returns the full decision table: which eligible-at-all
 * cards were readied, which were skipped, the rule that decided each, and the evidence behind it.
 * Never mutates `tasks`. Deterministic: both lists are sorted by numeric card id.
 */
export async function vetAndReady({ tasks, gitLogGrep, cap = READY_CAP }) {
  // Codex review 2026-09-18, finding 4: the per-run cap is a hard ceiling -- a caller (config
  // parsing, a future direct caller of this library function) can lower it, never raise it above
  // READY_CAP. Enforced here, at the selection boundary itself, so this guarantee holds no
  // matter what any upstream config validation does or doesn't do.
  const effectiveCap = Math.min(cap, READY_CAP);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const eligible = tasks.filter(isEligibleAtAll);
  const decided = [];

  function skip(task, rule, check) {
    decided.push({ id: task.id, title: task.title, priority: task.priority, verdict: "skip", rule, reason: check.reason, evidence: check.evidence });
  }

  const passRule1 = [];
  for (const task of eligible) {
    const check = dependencyCheck(task, byId);
    if (check.ok) passRule1.push(task);
    else skip(task, "1-dependency", check);
  }

  const passRule3 = [];
  for (const task of passRule1) {
    const check = supersededCheck(task);
    if (check.ok) passRule3.push(task);
    else skip(task, "3-superseded", check);
  }

  const passRule2 = [];
  for (const task of passRule3) {
    const check = await mergedWorkCheck({ task, gitLogGrep });
    if (check.ok) passRule2.push(task);
    else skip(task, "2-merged", check);
  }

  const sorted = [...passRule2].sort((a, b) => priorityRank(a) - priorityRank(b) || numericId(a) - numericId(b));
  const readiedTasks = sorted.slice(0, effectiveCap);
  const overflow = sorted.slice(effectiveCap);

  for (const task of readiedTasks) {
    decided.push({
      id: task.id,
      title: task.title,
      priority: task.priority,
      verdict: "ready",
      rule: "5-cap-ok",
      reason: `every rule passed; readied (priority ${task.priority}, within the cap of ${effectiveCap})`,
      evidence: "",
      // T-0384 FIX ROUND 4 (Codex review 2026-09-19, P2 #1): the ORIGINAL, selection-time snapshot
      // of this card -- the one every rule above actually vetted -- carried forward so the caller
      // can compare it against a fresh re-fetch immediately before the write (see
      // `ops/vetAndReady.js`'s `findChangedVettedFields`). A body/acceptance change to a
      // different-but-still-eligible value has nothing else to be caught against: the fresh
      // snapshot alone always looks internally consistent.
      originalTask: task
    });
  }
  for (const task of overflow) {
    skip(task, "5-cap", {
      reason: `every other rule passed, but the per-run cap of ${effectiveCap} was already filled by higher-priority/earlier-id candidates`,
      evidence: ""
    });
  }

  return {
    eligibleCount: eligible.length,
    cap: effectiveCap,
    readied: decided.filter((entry) => entry.verdict === "ready").sort(byIdAscending),
    skipped: decided.filter((entry) => entry.verdict === "skip").sort(byIdAscending)
  };
}

/**
 * Codex review 2026-09-18, finding 3: `applyReadiedCards` must re-check a candidate's status,
 * eligibility scope, approval flag, body markers, and dependencies immediately before its write
 * -- a candidate selected minutes earlier (the run also does a poller fetch and a `git log` per
 * candidate in between) may no longer be the card that was actually vetted. This is the pure,
 * injectable core of that re-check: given the FRESHEST possible `task` and `tasksById` (a fresh
 * `GET /api/tasks` right before the apply loop, not the original selection-time snapshot),
 * decide whether the card is still safe to write.
 *
 * Deliberately does NOT re-run `mergedWorkCheck`: it's git-based and doesn't change within a
 * single run's timeframe, and re-running it (a subprocess per candidate) at write time would
 * meaningfully slow down every apply run for a check that can't itself have gone stale here.
 *
 * This narrows, but does not by itself close, the TOCTOU window -- there's still a gap between
 * this check and the actual `PATCH`. `applyReady`'s `expectedStatus` (via `X-Board-Expected-Status`,
 * `StaleWriteError` at the store layer) is what closes that last gap atomically with the write.
 */
export function revalidateCandidate(task, tasksById) {
  if (!task) {
    return { ok: false, reason: "card no longer exists at write time", evidence: "" };
  }
  if (!isEligibleAtAll(task)) {
    return {
      ok: false,
      reason:
        `no longer eligible at write time -- status=${task.status}, agent=${task.agent}, ` +
        `deliverable_type=${task.deliverable_type ?? "code"}, requires_approval=${task.requires_approval === true}`,
      evidence: ""
    };
  }
  const depCheck = dependencyCheck(task, tasksById);
  if (!depCheck.ok) {
    return { ok: false, reason: `dependency changed at write time -- ${depCheck.reason}`, evidence: depCheck.evidence };
  }
  const superseded = supersededCheck(task);
  if (!superseded.ok) {
    return { ok: false, reason: `body changed at write time -- ${superseded.reason}`, evidence: superseded.evidence };
  }
  return {
    ok: true,
    reason: "revalidated immediately before write: still eligible, dependencies satisfied, no superseding marker",
    evidence: ""
  };
}
