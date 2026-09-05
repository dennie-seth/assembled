#!/usr/bin/env node
/**
 * The command an agent or the runner invokes to answer "is this card approved?" (T-0307).
 *
 *   node tools/board/scripts/checkApproval.js <T-NNNN>
 *
 * Consults the live board first; approval-ledger.json is used only when it is fresh enough or
 * already knows the card isn't gated (see src/lib/approvalCheck.js). Never reads the ledger as
 * if it were the answer on its own -- that misreading is exactly what burned five T-0274 runs.
 *
 * Prints the verdict as JSON on stdout. Exit code 0 means the card may proceed (approved, or
 * never required approval); exit code 1 means the gate is refused -- check `verified` in the
 * output to tell a genuine "not approved" apart from "the board could not be reached".
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkApproval, DEFAULT_FRESHNESS_BUDGET_MS } from "../src/lib/approvalCheck.js";
import { DEFAULT_BOARD_PORT } from "../src/lib/agentCurlPolicy.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_LEDGER_PATH = path.join(REPO_ROOT, "tools", "board", "approval-ledger.json");

async function main() {
  const taskId = process.argv[2];
  if (!taskId) {
    console.error("Usage: node tools/board/scripts/checkApproval.js <T-NNNN>");
    process.exitCode = 1;
    return;
  }

  const boardBaseUrl =
    process.env.BOARD_BASE_URL || `http://127.0.0.1:${process.env.BOARD_PORT || DEFAULT_BOARD_PORT}`;
  const ledgerPath = process.env.BOARD_APPROVAL_LEDGER || DEFAULT_LEDGER_PATH;
  const freshnessBudgetMs = Number(process.env.BOARD_APPROVAL_FRESHNESS_BUDGET_MS) || DEFAULT_FRESHNESS_BUDGET_MS;

  const verdict = await checkApproval({ taskId, ledgerPath, boardBaseUrl, freshnessBudgetMs });
  console.log(JSON.stringify(verdict, null, 2));

  if (verdict.requiresApproval && !verdict.approved) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
