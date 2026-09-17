import { parseAcceptanceCriteria } from "../lib/acceptanceCriteria.js";

/**
 * Pre-flight check: verifies a card has a parseable ## Acceptance checklist
 * before the implementer phase starts. Returns {ok, message}.
 *
 * Why this exists: T-0186's sampled investigation found that 6 of 16 rework
 * cycles (37.5%) were caused solely by a missing Acceptance section — the
 * implementation was fully correct but the reviewer FAILed on the absent
 * checklist. Catching this before the implementer runs saves one full
 * implementer + one reviewer LLM call per underspecified card.
 *
 * For agent:null cards, this runs after the planner has expanded the spec;
 * for pre-assigned cards it runs immediately (the spec must already be complete).
 *
 * Delegates to parseAcceptanceCriteria (lib/acceptanceCriteria.js) so "parseable"
 * means exactly what the reviewer already requires: an ## Acceptance heading
 * followed by at least one checkbox item. A section with prose but no checkboxes
 * returns [] from that parser and is also blocked.
 */
export function checkAcceptancePreflight(task) {
  const id = task?.id ?? "unknown";
  const items = parseAcceptanceCriteria(task?.body ?? "");
  if (items.length === 0) {
    return {
      ok: false,
      message:
        `Card ${id} has no parseable ## Acceptance checklist — ` +
        `a card without checkable acceptance criteria cannot be verified by the reviewer. ` +
        `Add an ## Acceptance section with at least one checkbox item (- [ ] ...) before running.`
    };
  }
  return { ok: true, message: "" };
}
