import { ACCEPTANCE_HEADING_RE, CHECKBOX_RE } from "./acceptanceCriteria.js";

const HEADING_RE = /^#{1,6}\s+/;
const EDGE_CASES_LABEL_RE = /^\*\*Edge cases:?\*\*/i;

/**
 * The single definition of "a real Edge cases block" (T-0408): a bold `**Edge cases:**` label
 * line inside `## Acceptance`, followed by its own `- [ ]` checklist item before the next
 * heading of any level. A backticked mention of the phrase elsewhere in the body does not count
 * -- that's exactly the gap that made a naive grep overstate coverage on the live board (T-0408's
 * own card: 66 cards merely mention the phrase against only 5 with a real block).
 *
 * `edgeCasesPreflight.js`'s per-card warning and `auditEdgeCasesCoverage`'s board-wide count both
 * defer to this one function so the two can never quietly diverge on what counts.
 */
export function hasEdgeCasesBlock(body) {
  const text = body ?? "";
  const lines = text.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => ACCEPTANCE_HEADING_RE.test(line.trim()));
  if (startIdx === -1) {
    return false;
  }

  let labelIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (HEADING_RE.test(line)) break;
    if (EDGE_CASES_LABEL_RE.test(line)) {
      labelIdx = i;
      break;
    }
  }
  if (labelIdx === -1) {
    return false;
  }

  for (let i = labelIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (HEADING_RE.test(line)) break;
    if (CHECKBOX_RE.test(line)) {
      return true;
    }
  }
  return false;
}

function countGroup(tasks) {
  return {
    cards: tasks.length,
    withBlock: tasks.filter((t) => hasEdgeCasesBlock(t?.body)).length
  };
}

/**
 * Re-runnable board-wide measurement of `## Acceptance` Edge cases coverage (T-0408), so the
 * 5/342 baseline the card measured by hand can be re-checked mechanically after the planner
 * prompt/guidance changes land. Never blocks or fails anything -- purely a report, the audit
 * analog of edgeCasesPreflight.js's per-card warning.
 *
 * `newestN` selects the N most recently `created` cards (string YYYY-MM-DD, descending; ties
 * broken by id descending) -- the card body's own "newest 25 cards" row.
 */
export function auditEdgeCasesCoverage(tasks, { newestN = 25 } = {}) {
  const all = tasks ?? [];

  const sorted = [...all].sort((a, b) => {
    const byCreated = String(b?.created ?? "").localeCompare(String(a?.created ?? ""));
    if (byCreated !== 0) return byCreated;
    return String(b?.id ?? "").localeCompare(String(a?.id ?? ""));
  });
  const newest = sorted.slice(0, newestN);

  const byAgentLists = new Map();
  for (const t of all) {
    const key = t?.agent ?? "unassigned";
    if (!byAgentLists.has(key)) byAgentLists.set(key, []);
    byAgentLists.get(key).push(t);
  }
  const byAgent = {};
  for (const [agent, list] of byAgentLists) {
    byAgent[agent] = countGroup(list);
  }

  return {
    total: countGroup(all),
    newest: { n: newestN, ...countGroup(newest) },
    byAgent
  };
}
