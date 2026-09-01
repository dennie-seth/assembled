/**
 * Minimal request-rate limiter for the reference-sourcing wrapper (T-0276): a hostile or
 * misbehaving source must not be hammered, and this project's own agents should not be able to
 * fire an unbounded burst of requests at a third party. `take()` throws once called again before
 * `minIntervalMs` has elapsed since the previous call; the caller (referenceSourcing.js) calls it
 * before every network request, search or fetch alike.
 */

export class RateLimitExceededError extends Error {}

export const DEFAULT_MIN_INTERVAL_MS = 1000;

/**
 * @param {object} [args]
 * @param {number} [args.minIntervalMs]
 * @param {() => number} [args.now] injectable clock, defaults to Date.now
 */
export function createRateLimiter({ minIntervalMs = DEFAULT_MIN_INTERVAL_MS, now = Date.now } = {}) {
  let lastTakenAt = null;
  return {
    take() {
      const current = now();
      if (lastTakenAt !== null && current - lastTakenAt < minIntervalMs) {
        throw new RateLimitExceededError(
          `must wait at least ${minIntervalMs}ms between reference-sourcing requests`
        );
      }
      lastTakenAt = current;
    }
  };
}
