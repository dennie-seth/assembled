#!/usr/bin/env node
import { mergeOriginRef } from "../src/runner/gitOps.js";

/**
 * CLI wrapper for `mergeOriginRef` (see gitOps.js for the fast-forward-then-fallback logic and
 * its tests). deploy.sh runs its own `git fetch origin <branch>` first, for its own distinct
 * "fetch failed" error message, then calls this to merge the already-fetched ref -- fast-forward
 * when there's nothing local to preserve, `--no-ff` only for genuine divergence. On conflict, the
 * merge is already aborted (clean working tree) by the time this exits non-zero.
 *
 * Usage: node mergeOriginRef.js <repoRoot> <branch>
 */
async function main() {
  const repoRoot = process.argv[2];
  const branch = process.argv[3] || "develop";
  if (!repoRoot) {
    console.error("usage: mergeOriginRef.js <repoRoot> [branch]");
    process.exitCode = 1;
    return;
  }
  await mergeOriginRef({ repoRoot, branch });
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
