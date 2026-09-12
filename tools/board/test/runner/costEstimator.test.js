import { describe, it, expect } from "vitest";
import { UsageLedgerReadIndeterminateError } from "../../src/runner/usageLedger.js";
import {
  ESTIMATOR_VERSION,
  DEFAULT_COVERAGE_TARGET,
  TYPE_PRIORS,
  MIN_SAMPLES_FOR_EMPIRICAL_ESTIMATE,
  ESTIMATE_SOURCE,
  observationFromAttemptEntry,
  observationFromAggregate,
  estimateCost,
  measureCoverage,
  buildCostEstimatorTable,
  collectObservationsFromLedger
} from "../../src/runner/costEstimator.js";

function exactEntry(costUsd, overrides = {}) {
  return { costUsd, complete: true, outcome: "success", ...overrides };
}

function censoredEntry(costUsd, overrides = {}) {
  return { costUsd, complete: false, outcome: "crashed", ...overrides };
}

describe("observationFromAttemptEntry", () => {
  it("is exact when the entry is complete with a known numeric cost", () => {
    const obs = observationFromAttemptEntry(exactEntry(1.5));
    expect(obs).toEqual({ censored: false, costUsd: 1.5 });
  });

  it("is censored (lower bound) when the entry is incomplete", () => {
    const obs = observationFromAttemptEntry(censoredEntry(4.2));
    expect(obs).toEqual({ censored: true, lowerBoundUsd: 4.2 });
  });

  it("is censored at lower bound 0 when an incomplete entry has no known cost at all", () => {
    const obs = observationFromAttemptEntry(censoredEntry(null));
    expect(obs).toEqual({ censored: true, lowerBoundUsd: 0 });
  });

  it("is censored, never a measured zero, when a COMPLETE entry's own cost is unknown", () => {
    // usageLedger's summarizeUsageFromEvents can report costUsd: null on a valid `result` event
    // that never carried a total_cost_usd figure -- unknown, not a measured zero-cost completion.
    const obs = observationFromAttemptEntry(exactEntry(null));
    expect(obs.censored).toBe(true);
    expect(obs.lowerBoundUsd).toBe(0);
  });
});

describe("observationFromAggregate (T-0367 consumer contract 2)", () => {
  it("is exact when every contributing entry's cost is known", () => {
    const obs = observationFromAggregate({ costUsd: 3, knownCostUsd: 3, unknownCostEntries: 0 });
    expect(obs).toEqual({ censored: false, costUsd: 3 });
  });

  it("is censored at the known subtotal when the aggregate is a mixed known/unknown collection", () => {
    const obs = observationFromAggregate({ costUsd: null, knownCostUsd: 5, unknownCostEntries: 2 });
    expect(obs).toEqual({ censored: true, lowerBoundUsd: 5 });
  });

  it("is censored at 0 -- never a measured zero -- when the aggregate is entirely unknown cost", () => {
    const obs = observationFromAggregate({ costUsd: null, knownCostUsd: 0, unknownCostEntries: 3 });
    expect(obs).toEqual({ censored: true, lowerBoundUsd: 0 });
  });

  it("never reports a mixed aggregate's measured value as smaller than its known subtotal", () => {
    const obs = observationFromAggregate({ costUsd: null, knownCostUsd: 12.5, unknownCostEntries: 1 });
    expect(obs.censored).toBe(true);
    expect(obs.lowerBoundUsd).toBe(12.5);
  });
});

describe("estimateCost -- stored estimate shape (acceptance 1)", () => {
  it("returns a number with explicit units, estimate_source, estimator_version, and an uncertainty measure", () => {
    const observations = [1, 2, 3, 4, 5, 6, 7].map((v) => ({ censored: false, costUsd: v }));
    const estimate = estimateCost({ type: "infra-small", observations });
    expect(typeof estimate.value).toBe("number");
    expect(estimate.unit).toBe("usd");
    expect(estimate.estimateSource).toBeTypeOf("string");
    expect(estimate.estimatorVersion).toBe(ESTIMATOR_VERSION);
    expect(estimate.uncertainty).toBeTruthy();
    expect(typeof estimate.uncertainty.value).toBe("number");
    // Never a "bucket" field masquerading as the unit -- units and any human bucket are distinct.
    expect(estimate).not.toHaveProperty("bucket");
    expect(estimate).not.toHaveProperty("cost_band");
  });
});

describe("estimateCost -- coverage target, not average (acceptance 2)", () => {
  it("targets an explicit upper quantile plus margin, well above the plain mean of skewed data", () => {
    const values = [1, 1, 1, 1, 1, 1, 1, 1, 1, 20]; // heavily right-skewed
    const observations = values.map((v) => ({ censored: false, costUsd: v }));
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const estimate = estimateCost({ type: "infra-small", observations, coverageTarget: 0.9 });
    expect(estimate.coverageTarget).toBe(0.9);
    expect(estimate.value).toBeGreaterThan(mean);
  });

  it("reports the measured fraction of exact/proven-exceeded observations that exceeded the estimate", () => {
    const observations = [1, 1, 1, 1, 1, 1, 1, 1, 1, 20].map((v) => ({ censored: false, costUsd: v }));
    const estimate = estimateCost({ type: "infra-small", observations, coverageTarget: 0.5 });
    const coverage = measureCoverage(observations, estimate);
    expect(coverage.evaluated).toBeGreaterThan(0);
    expect(coverage.fraction).toBeGreaterThanOrEqual(0);
    expect(coverage.fraction).toBeLessThanOrEqual(1);
    expect(coverage.exceeded).toBe(Math.round(coverage.fraction * coverage.evaluated));
  });
});

describe("estimateCost -- censored observations enter calibration as lower bounds (acceptance 3)", () => {
  it("an expensive interrupted attempt raises the estimate instead of vanishing from it", () => {
    const completedOnly = [1, 1, 1, 1, 1, 1, 1, 1].map((v) => ({ censored: false, costUsd: v }));
    const withCensoredOutlier = [...completedOnly, { censored: true, lowerBoundUsd: 500 }];

    const withoutCensored = estimateCost({ type: "infra-small", observations: completedOnly, coverageTarget: 0.9 });
    const withCensored = estimateCost({ type: "infra-small", observations: withCensoredOutlier, coverageTarget: 0.9 });

    expect(withCensored.value).toBeGreaterThan(withoutCensored.value);
    expect(withCensored.censoredCount).toBe(1);
  });

  it("counts a censored observation whose lower bound already exceeds the estimate as a proven overrun", () => {
    const observations = [1, 1, 1, 1, 1, 1, 1, 1].map((v) => ({ censored: false, costUsd: v }));
    const estimate = estimateCost({ type: "infra-small", observations, coverageTarget: 0.9 });
    const withOverrun = [...observations, { censored: true, lowerBoundUsd: estimate.value + 100 }];
    const coverage = measureCoverage(withOverrun, estimate);
    expect(coverage.exceeded).toBeGreaterThanOrEqual(1);
  });
});

describe("estimateCost -- sparse-data priors and fail-safe hold (acceptance 4)", () => {
  it("falls back to the conservative type prior when samples are below the empirical minimum", () => {
    const observations = [{ censored: false, costUsd: 0.01 }]; // far below MIN_SAMPLES
    const estimate = estimateCost({ type: "infra-large", observations });
    expect(estimate.estimateSource).toBe(ESTIMATE_SOURCE.PRIOR);
    expect(estimate.value).toBe(TYPE_PRIORS["infra-large"].value);
    expect(estimate.unit).toBe(TYPE_PRIORS["infra-large"].unit);
  });

  it("covers every required prior type", () => {
    for (const type of ["infra-small", "infra-large", "asset-GPU", "review", "board-loop-fix"]) {
      expect(TYPE_PRIORS[type]).toBeTruthy();
      const estimate = estimateCost({ type, observations: [] });
      expect(estimate.estimateSource).toBe(ESTIMATE_SOURCE.PRIOR);
    }
  });

  it("classifies a card with no estimate and no matching prior as large / hold-for-sizing", () => {
    const estimate = estimateCost({ type: "unknown-type-nobody-registered", observations: [] });
    expect(estimate.estimateSource).toBe(ESTIMATE_SOURCE.UNKNOWN_HOLD);
    expect(estimate.classification).toBe("large_hold_for_sizing");
    expect(estimate.value).toBeNull();
  });

  it("respects the sparse-data threshold boundary", () => {
    expect(MIN_SAMPLES_FOR_EMPIRICAL_ESTIMATE).toBeGreaterThan(0);
    const belowThreshold = Array.from({ length: MIN_SAMPLES_FOR_EMPIRICAL_ESTIMATE - 1 }, () => ({ censored: false, costUsd: 1 }));
    expect(estimateCost({ type: "review", observations: belowThreshold }).estimateSource).toBe(ESTIMATE_SOURCE.PRIOR);
    const atThreshold = Array.from({ length: MIN_SAMPLES_FOR_EMPIRICAL_ESTIMATE }, () => ({ censored: false, costUsd: 1 }));
    expect(estimateCost({ type: "review", observations: atThreshold }).estimateSource).toBe(ESTIMATE_SOURCE.EMPIRICAL);
  });
});

describe("buildCostEstimatorTable -- versioned with sample counts and fit dates (acceptance 5)", () => {
  it("records estimator version, fit date, coverage target, and per-type sample counts", () => {
    const typeSamples = {
      review: Array.from({ length: 6 }, (_, i) => ({ censored: false, costUsd: i + 1 })),
      "infra-small": [{ censored: false, costUsd: 1 }]
    };
    const table = buildCostEstimatorTable({ typeSamples, fitDate: "2026-09-13T00:00:00.000Z", coverageTarget: 0.85 });
    expect(table.estimatorVersion).toBe(ESTIMATOR_VERSION);
    expect(table.fitDate).toBe("2026-09-13T00:00:00.000Z");
    expect(table.coverageTarget).toBe(0.85);
    expect(table.sampleCounts.review).toBe(6);
    expect(table.sampleCounts["infra-small"]).toBe(1);
    expect(table.types.review.estimateSource).toBe(ESTIMATE_SOURCE.EMPIRICAL);
    expect(table.types["infra-small"].estimateSource).toBe(ESTIMATE_SOURCE.PRIOR);
  });

  it("defaults the coverage target when the caller doesn't override it", () => {
    const table = buildCostEstimatorTable({ typeSamples: {}, fitDate: "2026-09-13T00:00:00.000Z" });
    expect(table.coverageTarget).toBe(DEFAULT_COVERAGE_TARGET);
  });
});

describe("collectObservationsFromLedger -- consumer contract 1: indeterminate reads never vanish", () => {
  it("preserves a UsageLedgerReadIndeterminateError as an explicit indeterminate marker, never as 0/[]", async () => {
    const listCardUsageEntriesFn = async ({ cardId }) => {
      if (cardId === "T-BAD") {
        throw new UsageLedgerReadIndeterminateError("simulated persistent contention");
      }
      return [{ costUsd: 2, complete: true, outcome: "success", attempt: 1 }];
    };

    const result = await collectObservationsFromLedger({
      runsDir: "/irrelevant",
      cardIds: ["T-GOOD", "T-BAD"],
      listCardUsageEntriesFn
    });

    expect(result.observations).toHaveLength(1);
    expect(result.indeterminateCardIds).toEqual(["T-BAD"]);
    // The indeterminate card is named, not silently folded into a zero-length observation set.
    expect(result.observations.some((o) => o.costUsd === 0)).toBe(false);
  });

  it("never throws past a single card's indeterminate read -- the rest of the pool is still collected", async () => {
    const listCardUsageEntriesFn = async ({ cardId }) => {
      if (cardId === "T-ONE") throw new UsageLedgerReadIndeterminateError("boom");
      return [];
    };
    await expect(
      collectObservationsFromLedger({ runsDir: "/irrelevant", cardIds: ["T-ONE", "T-TWO"], listCardUsageEntriesFn })
    ).resolves.toBeTruthy();
  });
});
