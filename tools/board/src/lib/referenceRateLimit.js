/**
 * Minimal request-pacing limiter for the reference-sourcing wrapper (T-0276): a hostile or
 * misbehaving source must not be hammered, and this project's own agents should not be able to
 * fire an unbounded burst of requests at a third party. `take()` *waits out* the remaining portion
 * of `minIntervalMs` since the previous call rather than rejecting the caller -- a single logical
 * operation (`fetchReference`) legitimately makes several network calls in a row (a metadata
 * lookup, the byte fetch, each redirect hop), and it must pace those, not fail itself. Throwing on
 * the second internal call of a single fetch was T-0276 review-run-1's defect: the CLI's core
 * `fetch` command self-tripped its own rate limiter every time (see docs/reference-sourcing-security.md).
 * The caller (referenceSourcing.js) awaits it before every network request, search or fetch alike.
 */

export const DEFAULT_MIN_INTERVAL_MS = 1000;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} [args]
 * @param {number} [args.minIntervalMs]
 * @param {() => number} [args.now] injectable clock, defaults to Date.now
 * @param {(ms: number) => Promise<void>} [args.sleep] injectable waiter, defaults to a real timer
 */
export function createRateLimiter({ minIntervalMs = DEFAULT_MIN_INTERVAL_MS, now = Date.now, sleep = defaultSleep } = {}) {
  let lastTakenAt = null;
  return {
    async take() {
      if (lastTakenAt !== null) {
        const remaining = minIntervalMs - (now() - lastTakenAt);
        if (remaining > 0) {
          await sleep(remaining);
        }
      }
      lastTakenAt = now();
    }
  };
}
