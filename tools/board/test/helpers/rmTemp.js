import fs from "node:fs/promises";

/**
 * Removes a temporary directory tree, tolerating the teardown race these tests keep losing.
 *
 * A test that runs `git` against a temp repo can finish its assertions while git still has
 * background work in flight (`git gc --auto` repacking, an index lock being released). The
 * teardown's `fs.rm` then walks a directory that gains a new file between readdir and rmdir,
 * and Node raises `ENOTEMPTY: directory not empty, rmdir '.../.git/objects/pack'`. Observed
 * on `gitOps.test.js` in CI while passing locally -- a textbook flake, since nothing about it
 * depends on the code under test.
 *
 * `force: true` alone does not help: it suppresses ENOENT, not ENOTEMPTY. Node's own answer is
 * `maxRetries`, which retries on EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM with a linear backoff of
 * `retryDelay` ms per attempt -- so this is the documented remedy, not a hand-rolled sleep loop.
 *
 * Deliberately test-only. The race is between a test's assertions and git's own background
 * work in a throwaway directory; no production code path removes a live repo out from under
 * git, so hardening production teardown would be fixing a bug that isn't there.
 */
export async function rmTemp(dir) {
  if (!dir) return;
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
