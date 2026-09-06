const AUTO_PUSH_DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/**
 * AUTO_PUSH_ON_COMMIT env var: default ON; set to "0"/"false"/"off"/"no" (any case) to disable
 * auto-pushing the board's own runtime commits (card create, comments, attachments) to origin.
 */
export function autoPushOnCommitFromEnv() {
  return !AUTO_PUSH_DISABLE_VALUES.has((process.env.AUTO_PUSH_ON_COMMIT ?? "").toLowerCase());
}

/**
 * `git push` on a branch origin has moved ahead of fails with "! [rejected] ... (fetch first)"
 * (or "(non-fast-forward)"/"behind" phrasing depending on git version) -- that's the one
 * failure mode worth reconciling and retrying. Anything else (no remote, no network, auth
 * failure, protected branch, ...) isn't something a merge+retry can fix, so it falls straight
 * to "log a warning and continue" instead.
 */
function isNonFastForwardRejection(err) {
  const message = String((err && err.message) || "");
  return /rejected/i.test(message) && /(non-fast-forward|fetch first|behind)/i.test(message);
}

/**
 * Pushes `branch` to origin. If origin has moved on since repoRoot's local `develop` last
 * synced -- exactly the steady-divergence problem this module exists to fix, since the board
 * commits runtime data (attachments, status writes) to `develop` and previously never pushed
 * it -- reconciles with one `git.mergeNoFF` (fetch + fast-forward-or-`--no-ff`, see gitOps.js)
 * and retries the push exactly once. Never force-pushes.
 *
 * Never throws: every outcome, including total failure, comes back as a result object so the
 * caller can log it. The local commit is never at risk either way -- only whether it made it
 * to origin yet.
 */
export async function attemptPush({ repoRoot, branch = "develop", git, logger = console }) {
  try {
    await git.push({ worktreeDir: repoRoot, branch });
    return { pushed: true, retried: false };
  } catch (err) {
    if (!isNonFastForwardRejection(err)) {
      logger.warn(`assembled-board: auto-push of ${branch} failed: ${err.message}`);
      return { pushed: false, retried: false, reason: "push-failed" };
    }
  }

  try {
    await git.mergeNoFF({ repoRoot, branch });
  } catch (err) {
    logger.warn(
      `assembled-board: auto-push of ${branch} rejected and could not reconcile with origin (${err.message}) -- local commit stands, will retry on the next runtime commit`
    );
    return { pushed: false, retried: false, reason: "merge-failed" };
  }

  try {
    await git.push({ worktreeDir: repoRoot, branch });
    return { pushed: true, retried: true };
  } catch (err) {
    logger.warn(
      `assembled-board: auto-push of ${branch} failed even after reconciling with origin (${err.message}) -- local commit stands`
    );
    return { pushed: false, retried: true, reason: "retry-push-failed" };
  }
}

// Chains scheduled pushes so overlapping calls (e.g. two attachment uploads seconds apart)
// serialize instead of racing each other over git's ref locks. Module-private: callers never
// see or wait on this, they only ever get a fire-and-forget schedulePush() back.
let pushChain = Promise.resolve();

/**
 * Fire-and-forget entry point, called right after a runtime commit lands (see gitOps.js's
 * `commitPaths`). Deliberately not `async` in a way callers would await: it returns
 * immediately, so it can never delay or fail the API request whose handler triggered the
 * commit. Every failure path inside `attemptPush` is already caught and logged there; the
 * `.catch()` here is only a last-resort net for something unexpected (e.g. a bug in the
 * chaining itself), so `schedulePush` itself can never produce an unhandled rejection.
 */
export function schedulePush({
  repoRoot,
  branch = "develop",
  git,
  logger = console,
  enabled = autoPushOnCommitFromEnv()
}) {
  if (!enabled) return;
  pushChain = pushChain
    .catch(() => {})
    .then(() => attemptPush({ repoRoot, branch, git, logger }))
    .catch((err) => {
      logger.warn(`assembled-board: auto-push of ${branch} threw unexpectedly: ${err.message}`);
    });
}
