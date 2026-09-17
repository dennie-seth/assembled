/**
 * WIP gate T-D fix round (Codex review of #387, finding 3, 2026-09-14): "every await added
 * before a launch is bounded and failure-isolated -- including the poller's readUsageTelemetry
 * read and launchCardRun's execution-ID read, not only withBoundedDecide". `launchAdvisory.js`'s
 * own `withBoundedDecide` already bounds the advisory `decide()` pipeline as a whole, but two
 * other awaits sit ahead of it on the shared launch path and were unbounded on their own: the
 * poller's telemetry read (before it even reaches `launchFn`) and `launchCardRun`'s
 * `ensureExecutionId` read (before it builds `decide()` at all). `withTimeout` is the one bounded-
 * await primitive both call, so a hung or throwing call anywhere on the path degrades to its
 * caller's fallback instead of ever stalling a poller tick or keeping `runCard` from being
 * called.
 */
export const DEFAULT_BOUND_MS = 8000;

/**
 * Races `fn()` against `timeoutMs`, always resolving -- never rejecting, never hanging past the
 * bound -- with either `fn`'s own resolved value or `fallback(reason, err?)`. `fn` is never
 * actually cancelled (Node has no such primitive): a slow `fn` keeps running in the background
 * after the timeout fires, and its eventual settlement is simply ignored -- the caller has
 * already moved on with the fallback by then.
 */
export function withTimeout(fn, { timeoutMs = DEFAULT_BOUND_MS, fallback, logger = console, label = "bounded call" } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.log(`${label}: exceeded ${timeoutMs}ms -- proceeding with fallback`);
      resolve(fallback("timeout"));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    Promise.resolve()
      .then(fn)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logger.log(`${label}: failed -- proceeding with fallback: ${err.message}`);
        resolve(fallback("error", err));
      });
  });
}
