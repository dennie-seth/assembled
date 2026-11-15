#!/usr/bin/env node
/**
 * Git merge driver for `tools/board/approval-ledger.json` (T-0464).
 *
 * Invoked by git as `node mergeApprovalLedgerDriver.js %O %A %B` -- %O is the common ancestor,
 * %A is "ours" (also the path git expects the merge result written to), %B is "theirs". Exit 0
 * and a rewritten %A means a clean merge; any non-zero exit leaves the file as a conflict for git
 * to report, same as the default text-merge behaviour this replaces for this one path.
 *
 * See `approvalLedgerMerge.js` for the actual merge logic (independently unit-tested) and
 * `tools/board/ops/install-approval-ledger-merge-driver.sh` for how this gets wired into local git
 * config -- a `.gitattributes` entry alone cannot register a driver's command, only its name.
 */
import { promises as fs } from "node:fs";
import { mergeApprovalLedgerJson } from "../src/lib/approvalLedgerMerge.js";

async function readOptional(filePath) {
  if (!filePath) return "";
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return "";
    throw err;
  }
}

async function main() {
  const [basePath, oursPath, theirsPath] = process.argv.slice(2);
  if (!oursPath || !theirsPath) {
    console.error("mergeApprovalLedgerDriver: expected git merge-driver args: %O %A %B");
    process.exitCode = 2;
    return;
  }

  const [baseText, oursText, theirsText] = await Promise.all([
    readOptional(basePath),
    fs.readFile(oursPath, "utf8"),
    fs.readFile(theirsPath, "utf8")
  ]);

  const result = mergeApprovalLedgerJson({ baseText, oursText, theirsText });
  if (!result.ok) {
    console.error(`mergeApprovalLedgerDriver: cannot auto-merge approval-ledger.json -- ${result.reason}`);
    process.exitCode = 1;
    return;
  }

  await fs.writeFile(oursPath, `${JSON.stringify(result.merged, null, 2)}\n`, "utf8");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
