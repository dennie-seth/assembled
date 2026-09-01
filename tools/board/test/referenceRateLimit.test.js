import { describe, it, expect } from "vitest";
import { createRateLimiter, RateLimitExceededError, DEFAULT_MIN_INTERVAL_MS } from "../src/lib/referenceRateLimit.js";

describe("createRateLimiter -- a hostile or misbehaving source cannot be hammered", () => {
  it("allows the first request", () => {
    let now = 1000;
    const limiter = createRateLimiter({ minIntervalMs: 1000, now: () => now });
    expect(() => limiter.take()).not.toThrow();
  });

  it("denies a second request inside the minimum interval", () => {
    let now = 1000;
    const limiter = createRateLimiter({ minIntervalMs: 1000, now: () => now });
    limiter.take();
    now += 500;
    expect(() => limiter.take()).toThrow(RateLimitExceededError);
  });

  it("allows a request once the minimum interval has elapsed", () => {
    let now = 1000;
    const limiter = createRateLimiter({ minIntervalMs: 1000, now: () => now });
    limiter.take();
    now += 1000;
    expect(() => limiter.take()).not.toThrow();
  });

  it("exposes a sane default interval", () => {
    expect(DEFAULT_MIN_INTERVAL_MS).toBeGreaterThan(0);
  });
});
