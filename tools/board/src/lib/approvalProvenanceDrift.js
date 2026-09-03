import { approvalVerdict } from "./approvalGate.js";

/** A card id token, e.g. `T-0257`. */
const TASK_ID_RE = /\bT-\d{4}\b/g;

/**
 * Phrases that mean "this row still reads unapproved" -- the exact wording
 * `ASSET_PROVENANCE.md`'s free-text approval note has used historically (see the T-0239/T-0257
 * rows). Matched case-insensitively against a single line.
 */
const STALE_PHRASES = [/not yet approved/i, /not approved/i, /pending (a )?direction approval/i];

/** The claim a row makes when it says the gate has already been cleared. */
const APPROVED_PHRASE = /\bAPPROVED\b/;

/**
 * Flags a provenance row whose own prose contradicts the board's approval verdict for the card
 * it names (T-0286, `docs/decision-log.md` DL-27).
 *
 * This is deliberately NOT a second approval resolver. `approvalGate.js`'s `approvalVerdict` is
 * the only function anything should ever call to answer "is this approved?" -- Option A's whole
 * point is that `ASSET_PROVENANCE.md`'s prose is never load-bearing for that question. This
 * function reads the prose in the other direction: given the board's real verdict, does the
 * provenance file's human-readable note about it still tell the truth? T-0257 was approved on
 * the board 2026-08-30; its provenance row kept reading "Not yet approved" for days, and nothing
 * caught that until a human noticed and PR #307 fixed it by hand. This is the mechanical version
 * of that noticing, so it happens on the next CI run instead of after T-0243/44/45/46 sit blocked.
 *
 * A row this function cannot confidently classify (no id, no approval-shaped phrase, or an id
 * with no matching task) is silently skipped, never guessed at -- a missed drift is a false
 * negative, which is safe; a fabricated one would be a false FAIL blocking an unrelated PR.
 *
 * @param {{ provenanceText: string, tasks: Array<object> }} args
 * @returns {{ ok: boolean, drifts: Array<{ taskId: string, kind: string, message: string }> }}
 */
export function findApprovalDrift({ provenanceText, tasks = [] }) {
  const verdictById = new Map();
  for (const t of tasks) {
    if (t && typeof t.id === "string") verdictById.set(t.id, approvalVerdict(t));
  }

  const drifts = [];
  const lines = typeof provenanceText === "string" ? provenanceText.split(/\r?\n/) : [];

  for (const line of lines) {
    const ids = [...new Set([...line.matchAll(TASK_ID_RE)].map((m) => m[0]))];
    if (ids.length === 0) continue;

    const isStaleClaim = STALE_PHRASES.some((re) => re.test(line));
    const isApprovedClaim = APPROVED_PHRASE.test(line);
    if (!isStaleClaim && !isApprovedClaim) continue;

    for (const id of ids) {
      const verdict = verdictById.get(id);
      if (!verdict || !verdict.requiresApproval) continue;

      if (isStaleClaim && verdict.approved) {
        drifts.push({
          taskId: id,
          kind: "stale-unapproved-claim",
          message:
            `ASSET_PROVENANCE.md still reads unapproved for ${id}, but the board record shows ` +
            `approved_by=${verdict.approvedBy} at ${verdict.approvedAt}. The board record is ` +
            `authoritative (T-0286, docs/decision-log.md DL-27) -- refresh or drop this row's prose.`
        });
      } else if (isApprovedClaim && !verdict.approved) {
        drifts.push({
          taskId: id,
          kind: "unsubstantiated-approved-claim",
          message:
            `ASSET_PROVENANCE.md claims ${id} is approved, but the board record has no recorded ` +
            `human approval (approved_by/approved_at empty). The board record is authoritative -- ` +
            `fix or remove this row's claim.`
        });
      }
    }
  }

  return { ok: drifts.length === 0, drifts };
}
