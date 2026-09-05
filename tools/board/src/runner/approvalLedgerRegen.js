import path from "node:path";
import { promises as fs } from "node:fs";
import { buildApprovalLedger, readApprovalLedger } from "../lib/approvalLedger.js";

/**
 * Regenerates the committed approval ledger inside a card's own worktree, right before
 * `_handlePass` (runOrchestrator.js) commits and pushes it (T-0313).
 *
 * Every card's branch gets this, not just ones that touch `ASSET_PROVENANCE.md` -- a per-card
 * allowlist needs updating every time a new surface starts reading the ledger (`checkApproval.js`
 * already does, independent of provenance), while "every branch" is self-healing by construction.
 * The cost is paid only when the content actually changes: `commitAll`'s existing `add -A` +
 * no-op-when-nothing-staged guard means an unrelated PR whose regenerated ledger matches the
 * committed one carries no trace of this step in its diff at all.
 *
 * Comparison is scoped to the two ledgers' `cards` arrays, never their full JSON -- `generated_at`
 * always differs run to run, so comparing the whole object would "change" the file on every PASS
 * regardless of whether any card's approval state actually moved, turning every unrelated PR into
 * ledger noise. Skipping the write when `cards` already matches is what keeps a no-op regeneration
 * truly silent.
 *
 * Merge-conflict rule for this generated file (a branch that later rebases or merges develop):
 * the ledger is a pure projection of the live board, like a lockfile -- the correct resolution is
 * re-running this function again post-merge, never hand-resolving the JSON diff by eye.
 *
 * Out of scope, deliberately: an approval granted after this card's PR opens but before it merges
 * leaves that PR's ledger snapshot stale until the next PASS on that branch (a merge-conflict
 * resolution run, or another push). Nothing here re-derives it live; the freshness gate in
 * `checkApprovalProvenanceDrift.js` is what catches a ledger that stops getting refreshed.
 */
export const APPROVAL_LEDGER_RELATIVE_PATH = path.join("tools", "board", "approval-ledger.json");

/**
 * @param {object} args
 * @param {string} args.worktreeDir - the card's own worktree (never repoRoot)
 * @param {Array<object>} args.tasks - the live store's full task list (e.g. `store.list()`)
 * @param {string} [args.ledgerRelativePath]
 * @param {() => Date} [args.now]
 * @param {typeof readApprovalLedger} [args.readLedgerFn]
 * @param {typeof fs.writeFile} [args.writeFileFn]
 * @returns {Promise<{changed: boolean, path: string}>}
 */
export async function regenerateApprovalLedgerIfChanged({
  worktreeDir,
  tasks,
  ledgerRelativePath = APPROVAL_LEDGER_RELATIVE_PATH,
  now,
  readLedgerFn = readApprovalLedger,
  writeFileFn = fs.writeFile
}) {
  const ledgerPath = path.join(worktreeDir, ledgerRelativePath);
  // A transient `store.list()` returning [] (db hiccup, race with a fs-mode scan) must never
  // overwrite a real, populated ledger with an empty one on this card's branch -- mirrors
  // exportApprovalLedger.js's own refusal to write an empty ledger.
  if (!tasks || tasks.length === 0) {
    return { changed: false, path: ledgerPath, skipped: true };
  }
  const existing = await readLedgerFn(ledgerPath);
  const next = buildApprovalLedger(tasks, now ? { now } : {});

  if (existing && JSON.stringify(existing.cards) === JSON.stringify(next.cards)) {
    return { changed: false, path: ledgerPath };
  }

  await writeFileFn(ledgerPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { changed: true, path: ledgerPath };
}
