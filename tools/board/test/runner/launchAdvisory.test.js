import { describe, it, expect, vi } from "vitest";
import { READING_STATUS } from "../../src/runner/usageTelemetry.js";
import { DEFAULT_ADMISSION_CONFIG, HOLD_REASON } from "../../src/runner/admissionDecision.js";
import { decideLaunchAdvisory } from "../../src/runner/advisoryLogger.js";
import {
  DEFAULT_ADVISORY_TIMEOUT_MS,
  resolveCostEstimatorType,
  reservedExecutionCycleEstimate,
  withBoundedDecide,
  buildLaunchDecide,
  sumActiveReservedRemainingCostUsd
} from "../../src/runner/launchAdvisory.js";

describe("resolveCostEstimatorType", () => {
  it("maps a known agent to a registered cost-estimator type", () => {
    expect(resolveCostEstimatorType({ agent: "infra" })).toBe("infra-small");
    expect(resolveCostEstimatorType({ agent: "assets" })).toBe("asset-GPU");
    expect(resolveCostEstimatorType({ agent: "audio" })).toBe("asset-GPU");
  });

  it("returns null for an agent with no registered mapping, rather than guessing", () => {
    expect(resolveCostEstimatorType({ agent: "server" })).toBeNull();
    expect(resolveCostEstimatorType({ agent: "some-future-agent" })).toBeNull();
    expect(resolveCostEstimatorType({})).toBeNull();
  });
});

describe("reservedExecutionCycleEstimate -- retries and the reviewer phase are included", () => {
  it("sums the implementer and reviewer estimates and multiplies by the attempt bound", () => {
    const result = reservedExecutionCycleEstimate({
      implementerEstimate: { value: 1, unit: "usd", estimatorVersion: "v1" },
      reviewEstimate: { value: 0.5, unit: "usd", estimatorVersion: "v1" },
      maxAttempts: 5
    });
    expect(result.value).toBeCloseTo((1 + 0.5) * 5);
    expect(result.unit).toBe("usd");
    expect(result.classification).toBe("reserved_execution_cycle");
  });

  it("is an explicit hold, never a fabricated number, when the implementer estimate is unknown", () => {
    const result = reservedExecutionCycleEstimate({
      implementerEstimate: { value: null, unit: "usd" },
      reviewEstimate: { value: 0.5, unit: "usd" },
      maxAttempts: 5
    });
    expect(result.value).toBeNull();
    expect(result.classification).toBe("large_hold_for_sizing");
  });

  it("is an explicit hold when the reviewer estimate is unknown", () => {
    const result = reservedExecutionCycleEstimate({
      implementerEstimate: { value: 1, unit: "usd" },
      reviewEstimate: { value: null, unit: "usd" },
      maxAttempts: 5
    });
    expect(result.value).toBeNull();
    expect(result.classification).toBe("large_hold_for_sizing");
  });
});

describe("withBoundedDecide -- failure isolation", () => {
  it("resolves with the underlying value when it settles quickly", async () => {
    const bounded = withBoundedDecide(async () => "ok", { timeoutMs: 1000, fallback: () => "fallback" });
    await expect(bounded()).resolves.toBe("ok");
  });

  it("resolves with the fallback, not a rejection, when the underlying function throws", async () => {
    const bounded = withBoundedDecide(
      async () => {
        throw new Error("boom");
      },
      { timeoutMs: 1000, fallback: (reason) => `fallback:${reason}` }
    );
    await expect(bounded()).resolves.toBe("fallback:error");
  });

  it("resolves with the fallback after timeoutMs when the underlying function never settles in time", async () => {
    vi.useFakeTimers();
    try {
      const bounded = withBoundedDecide(() => new Promise(() => {}), {
        timeoutMs: 50,
        fallback: (reason) => `fallback:${reason}`
      });
      const promise = bounded();
      await vi.advanceTimersByTimeAsync(60);
      await expect(promise).resolves.toBe("fallback:timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults to a bounded timeout so a hung telemetry/estimator call can never hang a launch indefinitely", () => {
    expect(DEFAULT_ADVISORY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_ADVISORY_TIMEOUT_MS).toBeLessThan(60_000);
  });
});

function telemetryReadings(overrides = {}) {
  return {
    five_hour: { windowKind: "five_hour", classification: READING_STATUS.MEASURED, utilization: 0.1, resetElapsed: false },
    seven_day: { windowKind: "seven_day", classification: READING_STATUS.MEASURED, utilization: 0.1, resetElapsed: false },
    ...overrides
  };
}

describe("buildLaunchDecide -- composes T-0367 telemetry, T-0369 estimation, and the reservation ledger", () => {
  function baseDeps(overrides = {}) {
    return {
      runsDir: "/irrelevant",
      cardId: "T-0001",
      executionId: "exec-1",
      invocationId: "inv-1",
      type: "infra-small",
      owner: "cardLaunch:T-0001",
      maxAttempts: 5,
      admissionConfig: DEFAULT_ADMISSION_CONFIG,
      logger: { log: vi.fn(), error: vi.fn() },
      readUsageTelemetryFn: vi.fn(async () => telemetryReadings()),
      decideLaunchAdvisoryFn: vi.fn(async ({ type } = {}) => ({
        estimate:
          type === "infra-small"
            ? { value: 0.5, unit: "usd", classification: "prior", estimatorVersion: "v1" }
            : { value: null, unit: "usd", classification: "large_hold_for_sizing", estimatorVersion: "v1" },
        telemetryReadings: telemetryReadings(),
        type,
        fitDate: null,
        reason: `estimate for T-0001 (${type}) from 0 prior observation(s)`
      })),
      listCardUsageEntriesFn: vi.fn(async () => []),
      listActiveReservationsFn: vi.fn(async () => []),
      reserveLaunchSlotFn: vi.fn(async (args) => ({ ...args, released: false })),
      recordAdvisoryDecisionFn: vi.fn(async (args) => ({ ...args, outcome: null })),
      ...overrides
    };
  }

  it("reserves the implementer + reviewer cost across the attempt bound, minus what the ledger already charged for this execution", async () => {
    const deps = baseDeps({
      listCardUsageEntriesFn: vi.fn(async () => [
        { executionId: "exec-1", attempt: 1, phase: "implementer", retry: 0, costUsd: 0.3, complete: true, outcome: "quota_stop" }
      ])
    });
    const record = await buildLaunchDecide(deps)();
    expect(deps.reserveLaunchSlotFn).toHaveBeenCalledTimes(1);
    const reserveCall = deps.reserveLaunchSlotFn.mock.calls[0][0];
    expect(reserveCall.cardId).toBe("T-0001");
    expect(reserveCall.reservedCostUsd).toBeGreaterThan(0);
    // implementer estimate 0.5usd, review prior 0.75usd -> (0.5+0.75)*5 = 6.25, minus 0.3 already charged
    expect(reserveCall.reservedCostUsd).toBeCloseTo(6.25 - 0.3);
    expect(record.estimate).toBeDefined();
    expect(record.telemetryReadings).toBeDefined();
  });

  it("never counts usage already charged in the ledger as still-unspent reservation", async () => {
    const heavilyCharged = baseDeps({
      listCardUsageEntriesFn: vi.fn(async () => [
        { executionId: "exec-1", attempt: 1, phase: "implementer", retry: 0, costUsd: 100, complete: true, outcome: "success" }
      ])
    });
    const record = await buildLaunchDecide(heavilyCharged)();
    const reserveCall = heavilyCharged.reserveLaunchSlotFn.mock.calls[0][0];
    // reserved execution cycle cost (6.25) is far less than what's already charged (100) -- never reserve a negative amount
    expect(reserveCall.reservedCostUsd).toBe(0);
    expect(record).toBeDefined();
  });

  it("only counts usage charged under THIS execution's id, not a previous launch's", async () => {
    const deps = baseDeps({
      executionId: "exec-2",
      listCardUsageEntriesFn: vi.fn(async () => [
        { executionId: "exec-1", attempt: 1, phase: "implementer", retry: 0, costUsd: 5, complete: true, outcome: "success" }
      ])
    });
    const record = await buildLaunchDecide(deps)();
    const reserveCall = deps.reserveLaunchSlotFn.mock.calls[0][0];
    expect(reserveCall.reservedCostUsd).toBeCloseTo(6.25);
    expect(record).toBeDefined();
  });

  it("returns a scoreable record shape recordAdvisoryDecision can persist directly", async () => {
    const deps = baseDeps();
    const record = await buildLaunchDecide(deps)();
    expect(record).toMatchObject({
      type: "infra-small",
      telemetryReadings: expect.any(Object),
      reason: expect.any(String)
    });
    expect(record.estimate.value === null || (typeof record.estimate.value === "number" && Number.isFinite(record.estimate.value))).toBe(
      true
    );
  });

  it("is failure-isolated: a throwing telemetry reader still yields a scoreable hold record, never throws", async () => {
    const deps = baseDeps({
      // Use the real decideLaunchAdvisory (T-0369) so its own unguarded `await readUsageTelemetryFn(...)`
      // call is what actually throws -- proving the failure isolation reaches through T-0369's module,
      // not just around a test double standing in for it.
      decideLaunchAdvisoryFn: decideLaunchAdvisory,
      readUsageTelemetryFn: vi.fn(async () => {
        throw new Error("telemetry unreadable");
      })
    });
    const record = await buildLaunchDecide(deps)();
    expect(record.estimate.value).toBeNull();
    expect(record.telemetryReadings).toEqual({});
  });

  it("is failure-isolated: a throwing estimator still yields a scoreable hold record, never throws", async () => {
    const deps = baseDeps({
      decideLaunchAdvisoryFn: vi.fn(async () => {
        throw new Error("estimator blew up");
      })
    });
    const record = await buildLaunchDecide(deps)();
    expect(record.estimate.value === null || typeof record.estimate.value === "number").toBe(true);
  });

  it("is failure-isolated: an unreadable ledger for the already-charged lookup still yields a scoreable record, never throws", async () => {
    const deps = baseDeps({
      listCardUsageEntriesFn: vi.fn(async () => {
        throw new Error("ledger unreadable");
      })
    });
    const record = await buildLaunchDecide(deps)();
    expect(record.estimate.value === null || typeof record.estimate.value === "number").toBe(true);
    expect(deps.reserveLaunchSlotFn).toHaveBeenCalled();
  });

  it("is failure-isolated: a throwing reservation call still yields a scoreable record, never throws", async () => {
    const deps = baseDeps({
      reserveLaunchSlotFn: vi.fn(async () => {
        throw new Error("disk full");
      })
    });
    const record = await buildLaunchDecide(deps)();
    expect(record).toBeDefined();
  });

  it("falls back to the registered type's indeterminate/hold estimate for an unregistered cost-estimator type", async () => {
    const deps = baseDeps({ type: null });
    const record = await buildLaunchDecide(deps)();
    expect(record.estimate.value).toBeNull();
  });

  it("persists the decision via T-0369's recordAdvisoryDecision, keyed by the same launch identity", async () => {
    const deps = baseDeps();
    const record = await buildLaunchDecide(deps)();
    expect(deps.recordAdvisoryDecisionFn).toHaveBeenCalledWith(
      expect.objectContaining({
        runsDir: "/irrelevant",
        cardId: "T-0001",
        executionId: "exec-1",
        invocationId: "inv-1",
        type: "infra-small",
        estimate: record.estimate,
        telemetryReadings: record.telemetryReadings,
        reason: record.reason
      })
    );
  });

  it("is failure-isolated: a throwing recordAdvisoryDecisionFn still returns the computed record, never throws", async () => {
    const deps = baseDeps({
      recordAdvisoryDecisionFn: vi.fn(async () => {
        throw new Error("disk full");
      })
    });
    const record = await buildLaunchDecide(deps)();
    expect(record.estimate).toBeDefined();
  });

  describe("T-0370 fix round finding 6 -- counts other active reservations at their REMAINING future cost", () => {
    it("reduces another active reservation's contribution by what its own execution already charged", async () => {
      const deps = baseDeps({
        listActiveReservationsFn: vi.fn(async () => [
          { cardId: "T-OTHER", executionId: "exec-other", reservedCostUsd: 10, released: false }
        ]),
        listCardUsageEntriesFn: vi.fn(async ({ cardId }) =>
          cardId === "T-OTHER"
            ? [{ executionId: "exec-other", attempt: 1, phase: "implementer", retry: 0, costUsd: 4, complete: true, outcome: "success" }]
            : []
        )
      });
      const record = await buildLaunchDecide(deps)();
      expect(record.reservedUnspentCostUsd).toBe(6);
    });

    it("is indeterminate (never 0) when the pool listing fails -- a failure to list the pool never becomes an empty pool", async () => {
      const deps = baseDeps({
        listActiveReservationsFn: vi.fn(async () => {
          throw new Error("EACCES");
        })
      });
      const record = await buildLaunchDecide(deps)();
      expect(record.reservedUnspentCostUsd).toBeNull();
      expect(record.admission.windows.five_hour.holdReason).toBe(HOLD_REASON.RESERVED_COST_UNKNOWN);
    });

    it("is indeterminate (never 0) when another reservation's own ledger read fails", async () => {
      const deps = baseDeps({
        listActiveReservationsFn: vi.fn(async () => [{ cardId: "T-OTHER", executionId: "exec-other", reservedCostUsd: 10, released: false }]),
        listCardUsageEntriesFn: vi.fn(async ({ cardId }) => {
          if (cardId === "T-OTHER") throw new Error("ledger unreadable");
          return [];
        })
      });
      const record = await buildLaunchDecide(deps)();
      expect(record.reservedUnspentCostUsd).toBeNull();
    });
  });

  describe("sumActiveReservedRemainingCostUsd -- the pure orchestration this card's admission check consumes", () => {
    it("sums the remaining cost across several active reservations", async () => {
      const total = await sumActiveReservedRemainingCostUsd({
        runsDir: "/irrelevant",
        reservations: [
          { cardId: "T-0001", executionId: "e1", reservedCostUsd: 10 },
          { cardId: "T-0002", executionId: "e2", reservedCostUsd: 5 }
        ],
        listCardUsageEntriesFn: vi.fn(async ({ cardId }) =>
          cardId === "T-0001" ? [{ executionId: "e1", costUsd: 4, complete: true, outcome: "success" }] : []
        )
      });
      expect(total).toBe(6 + 5);
    });

    it("returns null the instant any single reservation's ledger read fails", async () => {
      const total = await sumActiveReservedRemainingCostUsd({
        runsDir: "/irrelevant",
        reservations: [{ cardId: "T-0001", executionId: "e1", reservedCostUsd: 10 }],
        listCardUsageEntriesFn: vi.fn(async () => {
          throw new Error("unreadable");
        })
      });
      expect(total).toBeNull();
    });
  });
});
