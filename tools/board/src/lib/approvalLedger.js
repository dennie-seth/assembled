import { promises as fs } from "node:fs";

/**
 * The approval fields a drift check needs, and nothing else.
 *
 * `checkApprovalProvenanceDrift.js` runs in CI, where the board's live task store is
 * unreachable: the board runs `BOARD_TASK_STORE=db` against a SQLite file on the dev machine,
 * and GitHub Actions has no path to it. `FsTaskStore`'s `tasks/*.md` stops at T-0222, so every
 * card from ~T-0223 onward resolved to nothing and the gate reported
 * `unverifiable-approval-claim` -- failing closed on EVERY PR that touched `ASSET_PROVENANCE.md`
 * (observed on #315: 8 of 9 checks green, this the only red).
 *
 * Failing closed was the right instinct -- T-0286's whole point is that "couldn't check" must
 * never read as "passed" -- but a check that can never pass is not a gate, it is a blocker.
 *
 * This ledger is the missing data source: a small, source-controlled export of the board's
 * approval record, committed to the repo so CI can verify against it offline. It is NOT a second
 * approval authority -- the board remains the single source of truth (DL-27). It is a snapshot of
 * that truth, and `staleAfterDays` exists so the snapshot cannot quietly become the next thing
 * that drifts.
 */

/** Only these fields are exported. A ledger is an approval record, not a task mirror. */
export const LEDGER_FIELDS = Object.freeze(["id", "requires_approval", "approved_by", "approved_at"]);

export const LEDGER_VERSION = 1;

/** Projects a task list down to the approval fields, sorted by id for a stable diff. */
export function buildApprovalLedger(tasks, { now = () => new Date() } = {}) {
  const entries = [];
  for (const t of tasks ?? []) {
    if (!t || typeof t.id !== "string") continue;
    entries.push({
      id: t.id,
      requires_approval: Boolean(t.requires_approval),
      approved_by: t.approved_by ?? null,
      approved_at: t.approved_at ?? null
    });
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { version: LEDGER_VERSION, generated_at: now().toISOString(), cards: entries };
}

/** Reads a ledger file. Returns null when absent -- absence is a condition the caller must handle. */
export async function readApprovalLedger(ledgerPath, { readFileFn = fs.readFile } = {}) {
  let raw;
  try {
    raw = await readFileFn(ledgerPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.cards)) {
    throw new Error(`${ledgerPath}: not a valid approval ledger (missing "cards" array)`);
  }
  return parsed;
}

/**
 * Age of a ledger in whole days. A snapshot that is not refreshed is exactly the drift T-0286
 * exists to prevent, one level up -- so callers gate on this rather than trusting it forever.
 */
export function ledgerAgeDays(ledger, { now = () => new Date() } = {}) {
  if (!ledger || !ledger.generated_at) return Infinity;
  const t = Date.parse(ledger.generated_at);
  if (Number.isNaN(t)) return Infinity;
  return (now().getTime() - t) / 86400000;
}

/**
 * Live tasks win; ledger entries fill in only the ids the live store could not resolve.
 *
 * The ordering matters and is deliberate: on the board itself the db is reachable and
 * authoritative, so the ledger never overrides it and a stale snapshot cannot mask a real
 * board state. In CI the live store resolves nothing modern, so the ledger supplies it.
 */
export function mergeTasksWithLedger(tasks, ledger) {
  const merged = [];
  const seen = new Set();
  for (const t of tasks ?? []) {
    if (t && typeof t.id === "string") seen.add(t.id);
    merged.push(t);
  }
  let filled = 0;
  for (const entry of ledger?.cards ?? []) {
    if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) continue;
    merged.push({ ...entry, _source: "approval-ledger" });
    filled += 1;
  }
  return { tasks: merged, filledFromLedger: filled };
}
