import { describe, it, expect, vi } from "vitest";
import { DEFAULT_BOUND_MS, withTimeout } from "../../src/runner/boundedAwait.js";

describe("withTimeout -- T-0370 fix round finding 3: bounds every pre-launch await, not only withBoundedDecide", () => {
  it("resolves with the underlying value when it settles quickly", async () => {
    await expect(withTimeout(async () => "ok", { timeoutMs: 1000, fallback: () => "fallback" })).resolves.toBe("ok");
  });

  it("resolves with the fallback, not a rejection, when the underlying function throws", async () => {
    await expect(
      withTimeout(
        async () => {
          throw new Error("boom");
        },
        { timeoutMs: 1000, fallback: (reason) => `fallback:${reason}` }
      )
    ).resolves.toBe("fallback:error");
  });

  it("resolves with the fallback after timeoutMs when the underlying function never settles -- never hangs the caller", async () => {
    vi.useFakeTimers();
    try {
      const promise = withTimeout(() => new Promise(() => {}), {
        timeoutMs: 50,
        fallback: (reason) => `fallback:${reason}`
      });
      await vi.advanceTimersByTimeAsync(60);
      await expect(promise).resolves.toBe("fallback:timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a late resolution after the timeout has already fired is discarded -- the caller only ever observes the fallback", async () => {
    vi.useFakeTimers();
    try {
      let resolveLate;
      const promise = withTimeout(() => new Promise((resolve) => (resolveLate = resolve)), {
        timeoutMs: 50,
        fallback: () => "fallback"
      });
      await vi.advanceTimersByTimeAsync(60);
      await expect(promise).resolves.toBe("fallback");
      resolveLate("too-late");
      await vi.advanceTimersByTimeAsync(0);
      // No assertion needed beyond "this doesn't throw" -- the point is the caller already moved on.
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults to a bounded timeout, so an unbounded caller still can't hang forever", () => {
    expect(DEFAULT_BOUND_MS).toBeGreaterThan(0);
    expect(DEFAULT_BOUND_MS).toBeLessThan(60_000);
  });
});
