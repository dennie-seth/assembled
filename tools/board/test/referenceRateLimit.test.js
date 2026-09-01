import { describe, it, expect } from "vitest";
import { createRateLimiter, DEFAULT_MIN_INTERVAL_MS } from "../src/lib/referenceRateLimit.js";

describe("createRateLimiter -- paces requests instead of rejecting a fetch that must make several", () => {
  it("allows the first request without waiting", async () => {
    let now = 1000;
    const waited = [];
    const limiter = createRateLimiter({ minIntervalMs: 1000, now: () => now, sleep: async (ms) => waited.push(ms) });
    await limiter.take();
    expect(waited).toEqual([]);
  });

  it("waits out the remaining interval instead of throwing when called again too soon", async () => {
    let now = 1000;
    const waited = [];
    const limiter = createRateLimiter({
      minIntervalMs: 1000,
      now: () => now,
      sleep: async (ms) => {
        waited.push(ms);
        now += ms;
      }
    });
    await limiter.take();
    now += 500; // only 500ms of "real" time passed before the next call
    await limiter.take();
    expect(waited).toEqual([500]);
  });

  it("does not wait once the minimum interval has already elapsed", async () => {
    let now = 1000;
    const waited = [];
    const limiter = createRateLimiter({ minIntervalMs: 1000, now: () => now, sleep: async (ms) => waited.push(ms) });
    await limiter.take();
    now += 1000;
    await limiter.take();
    expect(waited).toEqual([]);
  });

  it("a single caller that must make several rapid internal requests (search + fetch + redirect hops) is paced, never rejected", async () => {
    let now = 1000;
    const waited = [];
    const limiter = createRateLimiter({
      minIntervalMs: 1000,
      now: () => now,
      sleep: async (ms) => {
        waited.push(ms);
        now += ms;
      }
    });
    await limiter.take();
    await limiter.take();
    await limiter.take();
    expect(waited).toEqual([1000, 1000]);
  });

  it("exposes a sane default interval", () => {
    expect(DEFAULT_MIN_INTERVAL_MS).toBeGreaterThan(0);
  });

  it("defaults to a real timer when no sleep is injected", async () => {
    const limiter = createRateLimiter({ minIntervalMs: 5 });
    const start = Date.now();
    await limiter.take();
    await limiter.take();
    expect(Date.now() - start).toBeGreaterThanOrEqual(4);
  });
});
