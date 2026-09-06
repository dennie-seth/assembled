import { readApprovalLedger, ledgerAgeDays } from "./approvalLedger.js";
import { DEFAULT_BOARD_PORT } from "./agentCurlPolicy.js";

/**
 * The live-board-first approval check (T-0307).
 *
 * `tools/board/approval-ledger.json` is a point-in-time export, committed so CI's offline
 * `checkApprovalProvenanceDrift.js` gate can resolve ids the CI task store can't reach
 * (see approvalLedger.js). It was never meant to be a second approval authority anywhere the
 * live board IS reachable -- but a blocker report treated it as exactly that, quoted
 * `approved_by: null` off a ledger generated 4h52m before the real approval landed, and fired
 * fail-closed against a gate a human had already lifted. Five T-0274 runs, a wrong escalation
 * (T-0306), and a P0 stalled for a day.
 *
 * `checkApproval` fixes the ordering: the live board (`GET /api/tasks/:id/approval`, the same
 * `approvalVerdict` endpoint DL-27 made authoritative) is always consulted before any fail-closed
 * gate fires, UNLESS the ledger is fresh enough to trust on its own -- bounded by
 * `freshnessBudgetMs`, deliberately short, so the ledger can only ever save an API call, never
 * mask a stale answer for long. A card the ledger already knows is not gated at all
 * (`requires_approval: false`) is a no-op regardless of ledger age, since that flag is set once by
 * a human and never toggled by automation (approvalGate.js) -- there is no fresher fact that could
 * change it.
 *
 * Fail-closed is preserved for what it exists for: a board that is genuinely unreachable, or that
 * answers with something this check cannot resolve to a verdict (404, a non-2xx status). Those
 * verdicts carry `verified: false` so a caller -- or a human reading the log line -- can tell
 * "couldn't check" apart from "checked, and it's still unapproved" at a glance.
 */

/** How old a ledger snapshot may be and still answer a gate on its own. Kept short on purpose: */
export const DEFAULT_FRESHNESS_BUDGET_MS = 5 * 60 * 1000;

const MS_PER_DAY = 86400000;

function ledgerAgeMs(ledger, now) {
  return ledgerAgeDays(ledger, { now }) * MS_PER_DAY;
}

function formatAge(ageMs) {
  if (ageMs === null || ageMs === undefined) return "n/a";
  if (!Number.isFinite(ageMs)) return "unknown";
  if (ageMs < 0) return "0s (clock skew: generated_at is in the future)";
  return `${Math.round(ageMs / 1000)}s`;
}

function verdictFor({ taskId, requiresApproval, approved, approvedBy = null, approvedAt = null, source, generatedAt = null, ageMs = null, verified, reason }) {
  return { taskId, requiresApproval, approved, approvedBy, approvedAt, source, generatedAt, ageMs, verified, reason };
}

/** Looks up `taskId` in an already-read ledger. Returns null if absent (ledger null or no match). */
function findLedgerEntry(ledger, taskId) {
  return ledger?.cards?.find((c) => c && c.id === taskId) ?? null;
}

/**
 * The single approval verdict for `taskId`, consulting the live board before any fail-closed gate
 * fires (see module docstring). Every parameter has a real default suitable for calling this from
 * a running board/agent process; tests override `readLedgerFn`/`fetchFn`/`now` to avoid touching
 * the filesystem or network.
 *
 * @param {object} args
 * @param {string} args.taskId
 * @param {string} args.ledgerPath - path to the committed approval-ledger.json
 * @param {string} [args.boardBaseUrl] - the live board's base URL
 * @param {typeof fetch} [args.fetchFn]
 * @param {number} [args.freshnessBudgetMs]
 * @param {() => Date} [args.now]
 * @param {typeof readApprovalLedger} [args.readLedgerFn]
 * @param {(message: string) => void} [args.log] - called once per gate refusal (fail-closed or a
 *   verified not-approved), never for an approved or non-gated verdict.
 */
export async function checkApproval({
  taskId,
  ledgerPath,
  boardBaseUrl = `http://127.0.0.1:${DEFAULT_BOARD_PORT}`,
  fetchFn = fetch,
  freshnessBudgetMs = DEFAULT_FRESHNESS_BUDGET_MS,
  now = () => new Date(),
  readLedgerFn = readApprovalLedger,
  log = (message) => console.error(message)
}) {
  let ledger = null;
  try {
    ledger = await readLedgerFn(ledgerPath);
  } catch {
    // Malformed/unreadable ledger is not fatal -- it just means this check has no fallback and
    // must resolve from the live board, same as a missing ledger.
    ledger = null;
  }

  const entry = findLedgerEntry(ledger, taskId);
  const ageMs = ledger ? ledgerAgeMs(ledger, now) : Infinity;

  // A card the ledger already knows is not gated at all is a no-op: requires_approval is set once
  // by a human (approvalGate.js) and never flips back on its own, so no ledger age could make
  // this answer wrong, and there is nothing here worth an API call.
  if (entry && entry.requires_approval === false) {
    return verdictFor({
      taskId,
      requiresApproval: false,
      approved: true,
      source: "ledger",
      generatedAt: ledger.generated_at,
      ageMs,
      verified: true,
      reason: "card does not require a human direction approval (ledger)"
    });
  }

  if (entry && ageMs <= freshnessBudgetMs) {
    const approved = Boolean(entry.approved_by);
    const verdict = verdictFor({
      taskId,
      requiresApproval: true,
      approved,
      approvedBy: entry.approved_by ?? null,
      approvedAt: entry.approved_at ?? null,
      source: "ledger",
      generatedAt: ledger.generated_at,
      ageMs,
      verified: true,
      reason: approved
        ? `approved by ${entry.approved_by} at ${entry.approved_at} (ledger, within the freshness budget)`
        : "requires_approval is set but the ledger records no approval (within the freshness budget)"
    });
    logRefusal(verdict, log);
    return verdict;
  }

  // Ledger missing, malformed, lacking this id, or older than the freshness budget: the ledger
  // cannot answer on its own, so the live board is the only source left that can.
  let res;
  try {
    res = await fetchFn(`${boardBaseUrl}/api/tasks/${taskId}/approval`);
  } catch (err) {
    const verdict = verdictFor({
      taskId,
      requiresApproval: true,
      approved: false,
      source: "board-unreachable",
      generatedAt: ledger?.generated_at ?? null,
      ageMs: ledger ? ageMs : null,
      verified: false,
      reason: `the live board is unreachable: ${err.message} -- failing closed (this is NOT a verified not-approved)`
    });
    logRefusal(verdict, log);
    return verdict;
  }

  if (res.status === 404) {
    const verdict = verdictFor({
      taskId,
      requiresApproval: true,
      approved: false,
      source: "board-404",
      generatedAt: ledger?.generated_at ?? null,
      ageMs: ledger ? ageMs : null,
      verified: false,
      reason: `the live board returned 404 for ${taskId} (deleted or renumbered) -- cannot verify, failing closed`
    });
    logRefusal(verdict, log);
    return verdict;
  }

  if (!res.ok) {
    const verdict = verdictFor({
      taskId,
      requiresApproval: true,
      approved: false,
      source: "board-error",
      generatedAt: ledger?.generated_at ?? null,
      ageMs: ledger ? ageMs : null,
      verified: false,
      reason: `the live board returned ${res.status} -- cannot verify, failing closed`
    });
    logRefusal(verdict, log);
    return verdict;
  }

  const body = await res.json();
  const verdict = verdictFor({
    taskId,
    requiresApproval: Boolean(body.requiresApproval),
    approved: Boolean(body.approved),
    approvedBy: body.approvedBy ?? null,
    approvedAt: body.approvedAt ?? null,
    source: "board-api",
    generatedAt: null,
    ageMs: 0,
    verified: true,
    reason: body.reason ?? ""
  });
  logRefusal(verdict, log);
  return verdict;
}

/** Logs once per gate refusal -- a verified not-approved or any fail-closed verdict. Never fires for approved/no-op. */
function logRefusal(verdict, log) {
  if (!verdict.requiresApproval || verdict.approved) return;
  log(
    `approval gate refused for ${verdict.taskId}: source=${verdict.source} ` +
      `generated_at=${verdict.generatedAt ?? "n/a"} age=${formatAge(verdict.ageMs)} verified=${verdict.verified} -- ${verdict.reason}`
  );
}
