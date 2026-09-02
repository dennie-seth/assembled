#!/usr/bin/env node
/**
 * Mechanical enforcement (T-0282) that a batch-fetch reference summary records `assetId` +
 * `sourceUrl` for every kept image, not just sha256/licence/retrievedAt -- the fields a human
 * needs to independently re-verify a licence claim after `assets/src/reference/quarantine/`
 * (gitignored) is reclaimed with the worktree. See T-0281's postmortem: the committed summary
 * had no source URL, and there was no way to recover one after the fact.
 *
 * Wired into `verifyRouter.js`'s `resolveVerifyRoutes`, which runs this automatically for any
 * diff touching `assets/src/reference/*-summary.md` -- independent of anyone remembering to run
 * it by hand. Reuses `checkKeptProvenance` from `src/lib/referenceBatchSummary.js`, the same
 * parser `renderCandidateTable`'s output round-trips through, so this check and that writer
 * cannot silently diverge on what "present" means.
 *
 * Usage: node tools/board/scripts/checkReferenceBatchSummary.js <summary.md> [<summary.md> ...]
 */
import { promises as fs } from "node:fs";
import { checkKeptProvenance } from "../src/lib/referenceBatchSummary.js";

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("usage: node tools/board/scripts/checkReferenceBatchSummary.js <summary.md> [<summary.md> ...]");
    process.exitCode = 64;
    return;
  }

  let allOk = true;
  for (const filePath of paths) {
    const markdown = await fs.readFile(filePath, "utf8");
    const report = checkKeptProvenance(markdown);
    if (report.ok) {
      console.log(`${filePath}: ok -- every kept image records an Asset ID and Source URL.`);
      continue;
    }
    allOk = false;
    console.error(`${filePath}: FAILED`);
    for (const message of report.errors) {
      console.error(`  ${message}`);
    }
  }

  if (!allOk) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
