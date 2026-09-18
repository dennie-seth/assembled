import { SATISFIED_DEP_STATUSES } from "../runner/autoLaunchPoller.js";

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
 * list rather than an open-ended heuristic -- "each decided mechanically" -- so a marker this
 * list doesn't cover is a known limitation, not a silent gap. "and so on" in the source spec is
 * exactly why this list may need a future addition; extend it here, in one place, when it does.
 */
export const SUPERSEDED_MARKERS = ["HELD", "RE-SCOPED", "RESCOPED", "SUPERSEDED", "This section governs", "STOP AND REPORT"];

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

/** Rule 3: the card body carries none of `SUPERSEDED_MARKERS`. */
export function supersededCheck(task) {
  const body = task.body ?? "";
  const hits = SUPERSEDED_MARKERS.filter((marker) => body.includes(marker));
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
 * Rule 2: not already satisfied by merged work, checked against `git log` on `develop` for
 * commits naming the card id. `gitLogGrep(cardId)` is injected (see
 * `tools/board/ops/vetAndReady.js`'s `makeGitLogGrep`) so this stays a pure function -- it never
 * shells out itself. Conservative on both failure modes: a hit is treated as "possibly already
 * satisfied" (skip), and a `git` error is treated as uncertain (skip) rather than either crashing
 * the run or silently treating the card as clear.
 *
 * This deliberately does not attempt the acceptance-path-diff half of the spec's example ("every
 * path its acceptance names already present with the described change") -- whether a path already
 * existing on develop reflects *this card's* described change is a semantic judgment call no
 * mechanical check can make safely (a path like `docs/PLAN.md` always exists, for reasons
 * unrelated to any one card), and a false "satisfied" verdict here is exactly the costly mistake
 * rule 2 exists to avoid. Same posture T-0383's DEPLOY.md documents for its own API-only limits.
 */
export async function mergedWorkCheck({ task, gitLogGrep }) {
  let hits;
  try {
    hits = await gitLogGrep(task.id);
  } catch (err) {
    return { ok: false, reason: `could not verify merged-work status (git check failed): ${err.message}`, evidence: "" };
  }
  if (!hits || hits.length === 0) {
    return { ok: true, reason: "no develop commits mention this card id", evidence: "" };
  }
  return {
    ok: false,
    reason: `possibly already satisfied by merged work -- develop has commit(s) mentioning ${task.id}`,
    evidence: hits.slice(0, 5).join(" | ")
  };
}

/**
 * Runs every rule in order over `tasks` and returns the full decision table: which eligible-at-all
 * cards were readied, which were skipped, the rule that decided each, and the evidence behind it.
 * Never mutates `tasks`. Deterministic: both lists are sorted by numeric card id.
 */
export async function vetAndReady({ tasks, gitLogGrep, cap = READY_CAP }) {
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
  const readiedTasks = sorted.slice(0, cap);
  const overflow = sorted.slice(cap);

  for (const task of readiedTasks) {
    decided.push({
      id: task.id,
      title: task.title,
      priority: task.priority,
      verdict: "ready",
      rule: "5-cap-ok",
      reason: `every rule passed; readied (priority ${task.priority}, within the cap of ${cap})`,
      evidence: ""
    });
  }
  for (const task of overflow) {
    skip(task, "5-cap", {
      reason: `every other rule passed, but the per-run cap of ${cap} was already filled by higher-priority/earlier-id candidates`,
      evidence: ""
    });
  }

  return {
    eligibleCount: eligible.length,
    cap,
    readied: decided.filter((entry) => entry.verdict === "ready").sort(byIdAscending),
    skipped: decided.filter((entry) => entry.verdict === "skip").sort(byIdAscending)
  };
}
