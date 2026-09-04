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
export default async function setup() {
  const before = await captureGitStatus(REPO_ROOT);

  return async function teardown() {
    const after = await captureGitStatus(REPO_ROOT);
    const newlyDirty = diffGitStatus(before, after);
    if (newlyDirty.length > 0) {
      throw new Error(
        "Working tree was left dirtier than before the test run -- a test wrote to the real " +
          "repo instead of an isolated fixture:\n" +
          newlyDirty.join("\n")
      );
    }
  };
}
