import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureGitStatus, diffGitStatus } from "../helpers/gitStatusSnapshot.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Suite-wide regression guard (T-0302): a git-writing test that leaks outside its isolated
 * fixture and touches the real checkout (see devShutdown.test.js's history -- it used to spawn
 * the real `npm run dev` against this repo's own tasks/, letting the orphan reaper commit
 * whatever real card happened to be stuck at in-progress) must fail the run loudly instead of
 * leaving staged pollution for someone to notice by hand. Runs once in Vitest's main process,
 * around the whole suite, not per file -- exactly the "byte-identical git status" property the
 * card asks for, checked against the real repo regardless of which file caused the drift.
 */
/**
 * Factory so the exit-code wiring below is testable against a throwaway fixture repo instead of
 * only the real checkout -- see workingTreeGuard.test.js.
 */
export function createGuard(repoRoot) {
  return async function setup() {
    const before = await captureGitStatus(repoRoot);

    return async function teardown() {
      const after = await captureGitStatus(repoRoot);
      const newlyDirty = diffGitStatus(before, after);
      if (newlyDirty.length > 0) {
        // Vitest 4.1's Vitest.close() awaits globalSetup teardowns but only logs a rejection
        // (teardownErrors -> logger.error) -- it never fails the run on its own. close() runs
        // before the process exits, and the exit handler only assigns exitCode when it's still
        // undefined, so setting it here is what actually turns this into a failed `npm test`.
        process.exitCode = 1;
        throw new Error(
          "Working tree was left dirtier than before the test run -- a test wrote to the real " +
            "repo instead of an isolated fixture:\n" +
            newlyDirty.join("\n")
        );
      }
    };
  };
}

export default createGuard(REPO_ROOT);
