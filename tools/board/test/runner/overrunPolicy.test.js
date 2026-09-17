import { describe, it, expect, vi } from "vitest";
import { evaluateOverrunPolicy, isBoundedContinuation, DEFAULT_OVERRUN_EXCEEDED_FRACTION, DEFAULT_OVERRUN_MIN_EVALUATED } from "../../src/runner/overrunPolicy.js";

function coverage(groups) {
  return { groups, excludedIndeterminate: 0, invalidPrediction: 0, pending: 0, unreadable: 0 };
}

describe("evaluateOverrunPolicy -- spec §11: record estimate overruns, stop new admissions in enforcement mode", () => {
  it("flags an overrun once the exceeded fraction reaches the threshold with enough evidence", async () => {
    const measureRecordedCoverageFn = vi.fn(async () => coverage({ "v1::fit": { evaluated: 4, exceeded: 3 } }));
    const result = await evaluateOverrunPolicy({ runsDir: "/irrelevant", measureRecordedCoverageFn });
    expect(result.overrun).toBe(true);
    expect(result.evaluated).toBe(4);
    expect(result.exceeded).toBe(3);
  });

  it("does not flag an overrun when the exceeded fraction is below the threshold", async () => {
    const measureRecordedCoverageFn = vi.fn(async () => coverage({ "v1::fit": { evaluated: 10, exceeded: 1 } }));
    const result = await evaluateOverrunPolicy({ runsDir: "/irrelevant", measureRecordedCoverageFn });
    expect(result.overrun).toBe(false);
  });

  it("never flags an overrun from too little evidence, even at a 100% exceeded fraction", async () => {
    const measureRecordedCoverageFn = vi.fn(async () => coverage({ "v1::fit": { evaluated: 1, exceeded: 1 } }));
    const result = await evaluateOverrunPolicy({ runsDir: "/irrelevant", measureRecordedCoverageFn, minEvaluated: 3 });
    expect(result.overrun).toBe(false);
    expect(result.reason).toMatch(/insufficient evidence/);
  });

  it("aggregates across multiple estimator/fit groups", async () => {
    const measureRecordedCoverageFn = vi.fn(async () =>
      coverage({
        "v1::fit-a": { evaluated: 2, exceeded: 2 },
        "v1::fit-b": { evaluated: 2, exceeded: 0 }
      })
    );
    const result = await evaluateOverrunPolicy({ runsDir: "/irrelevant", measureRecordedCoverageFn });
    expect(result.evaluated).toBe(4);
    expect(result.exceeded).toBe(2);
    expect(result.overrun).toBe(true); // 0.5 >= default 0.5 threshold
  });

  it("fails open (never an overrun) when the coverage evidence itself is unreadable", async () => {
    const measureRecordedCoverageFn = vi.fn(async () => {
      throw new Error("disk error");
    });
    const result = await evaluateOverrunPolicy({ runsDir: "/irrelevant", measureRecordedCoverageFn });
    expect(result.overrun).toBe(false);
    expect(result.reason).toMatch(/unreadable/);
  });

  it("exposes its defaults", () => {
    expect(DEFAULT_OVERRUN_EXCEEDED_FRACTION).toBeGreaterThan(0);
    expect(DEFAULT_OVERRUN_EXCEEDED_FRACTION).toBeLessThanOrEqual(1);
    expect(DEFAULT_OVERRUN_MIN_EVALUATED).toBeGreaterThan(0);
  });
});

describe("isBoundedContinuation -- spec §11: an already-admitted execution may continue through an overrun stop", () => {
  it("is a continuation when the execution already has ledger history", () => {
    expect(isBoundedContinuation({ priorEntriesForExecution: [{ costUsd: 0.1 }] })).toBe(true);
  });

  it("is NOT a continuation -- a brand-new admission -- when the execution has no prior ledger history", () => {
    expect(isBoundedContinuation({ priorEntriesForExecution: [] })).toBe(false);
    expect(isBoundedContinuation({ priorEntriesForExecution: undefined })).toBe(false);
  });
});
