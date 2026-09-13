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
  collectObservationsFromLedger,
  buildWeeklyCalibrationSummary
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
    // Corrected semantics (Codex WIP-gate batch review finding 1): a censored $500 lower bound that
    // an ordinary 0.9-coverage quantile can't support must NEVER be reported as a plain "empirical"
    // fit -- that would present a number the exact data alone doesn't back up as if it were a
    // confident measurement. It must surface a separately classified, still-raised fallback instead.
    expect(withCensored.classification).not.toBe("empirical");
    expect(withCensored.value).toBeGreaterThanOrEqual(500);
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
    // Below the type's prior ($0.75 for review) so the threshold boundary is what's under test,
    // not the separate prior-raised-by-observation behavior (see the dedicated finding-2 tests).
    const belowThreshold = Array.from({ length: MIN_SAMPLES_FOR_EMPIRICAL_ESTIMATE - 1 }, () => ({ censored: false, costUsd: 0.1 }));
    expect(estimateCost({ type: "review", observations: belowThreshold }).estimateSource).toBe(ESTIMATE_SOURCE.PRIOR);
    const atThreshold = Array.from({ length: MIN_SAMPLES_FOR_EMPIRICAL_ESTIMATE }, () => ({ censored: false, costUsd: 1 }));
    expect(estimateCost({ type: "review", observations: atThreshold }).estimateSource).toBe(ESTIMATE_SOURCE.EMPIRICAL);
  });
});

describe("buildCostEstimatorTable -- versioned with sample counts and fit dates (acceptance 5)", () => {
  it("records estimator version, fit date, coverage target, and per-type sample counts", () => {
    const typeSamples = {
      review: Array.from({ length: 6 }, (_, i) => ({ censored: false, costUsd: i + 1 })),
      // Below the infra-small prior ($0.50) -- this test is about sample-count-driven
      // PRIOR-vs-EMPIRICAL source selection, not the separate prior-raising behavior.
      "infra-small": [{ censored: false, costUsd: 0.1 }]
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

describe("buildWeeklyCalibrationSummary -- cadence (acceptance 5): a real summary from continuously collected data", () => {
  it("groups continuously collected ledger observations by type into a versioned, dated table", async () => {
    const listCardUsageEntriesFn = async ({ cardId }) => {
      const byCard = {
        "T-REVIEW-1": [1, 2, 3, 4, 5, 6].map((v) => ({ costUsd: v, complete: true, outcome: "success" })),
        "T-REVIEW-2": [{ costUsd: 7, complete: true, outcome: "success" }],
        "T-INFRA-1": [{ costUsd: 0.4, complete: true, outcome: "success" }]
      };
      return byCard[cardId] ?? [];
    };

    const summary = await buildWeeklyCalibrationSummary({
      runsDir: "/irrelevant",
      cardIdsByType: { review: ["T-REVIEW-1", "T-REVIEW-2"], "infra-small": ["T-INFRA-1"] },
      fitDate: "2026-09-13T00:00:00.000Z",
      listCardUsageEntriesFn
    });

    expect(summary.estimatorVersion).toBe(ESTIMATOR_VERSION);
    expect(summary.fitDate).toBe("2026-09-13T00:00:00.000Z");
    expect(summary.sampleCounts.review).toBe(7);
    expect(summary.types.review.estimateSource).toBe(ESTIMATE_SOURCE.EMPIRICAL);
    expect(summary.sampleCounts["infra-small"]).toBe(1);
    expect(summary.types["infra-small"].estimateSource).toBe(ESTIMATE_SOURCE.PRIOR);
  });

  it("reports each type's in-sample fit diagnostic alongside its estimate, named as a diagnostic (finding 5/7)", async () => {
    // Corrected semantics (Codex WIP-gate batch review finding 5): fitting an estimate from a pool
    // and then scoring that SAME pool against it is a fit-on-training-data check, not real
    // coverage (real coverage compares realized outcomes to their pre-launch, immutable recorded
    // predictions -- see advisoryLogger.test.js's measureRecordedCoverage). This field is renamed
    // and must never be presented as "coverage".
    const listCardUsageEntriesFn = async () =>
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 20].map((v) => ({ costUsd: v, complete: true, outcome: "success" }));

    const summary = await buildWeeklyCalibrationSummary({
      runsDir: "/irrelevant",
      cardIdsByType: { review: ["T-A"] },
      fitDate: "2026-09-13T00:00:00.000Z",
      coverageTarget: 0.5,
      listCardUsageEntriesFn
    });

    expect(summary.types.review).not.toHaveProperty("coverage");
    expect(summary.types.review.inSampleFitDiagnostic).toBeTruthy();
    expect(summary.types.review.inSampleFitDiagnostic.evaluated).toBeGreaterThan(0);
    expect(summary.types.review.inSampleFitDiagnostic.fraction).toBeGreaterThanOrEqual(0);
    expect(summary.types.review.inSampleFitDiagnostic.fraction).toBeLessThanOrEqual(1);
  });

  it("names indeterminate cards per type instead of silently shrinking that type's calibration pool", async () => {
    const listCardUsageEntriesFn = async ({ cardId }) => {
      if (cardId === "T-BAD") throw new UsageLedgerReadIndeterminateError("simulated contention");
      return [{ costUsd: 1, complete: true, outcome: "success" }];
    };

    const summary = await buildWeeklyCalibrationSummary({
      runsDir: "/irrelevant",
      cardIdsByType: { review: ["T-GOOD", "T-BAD"] },
      fitDate: "2026-09-13T00:00:00.000Z",
      listCardUsageEntriesFn
    });

    expect(summary.indeterminateCardIds.review).toEqual(["T-BAD"]);
    expect(summary.sampleCounts.review).toBe(1);
  });
});

describe("buildWeeklyCalibrationSummary -- stays indeterminate, never a usable estimate from a reduced pool (Codex WIP-gate batch review finding 4)", () => {
  it("publishes an explicit indeterminate classification and reason naming the cards, for a type where EVERY card is unreadable", async () => {
    const listCardUsageEntriesFn = async () => {
      throw new UsageLedgerReadIndeterminateError("simulated persistent contention");
    };

    const summary = await buildWeeklyCalibrationSummary({
      runsDir: "/irrelevant",
      cardIdsByType: { review: ["T-UNREADABLE-1", "T-UNREADABLE-2"] },
      fitDate: "2026-09-13T00:00:00.000Z",
      listCardUsageEntriesFn
    });

    expect(summary.types.review.classification).toBe("indeterminate");
    expect(summary.types.review.value).toBeNull();
    expect(summary.types.review.estimateSource).not.toBe(ESTIMATE_SOURCE.EMPIRICAL);
    expect(summary.types.review.estimateSource).not.toBe(ESTIMATE_SOURCE.PRIOR);
    expect(summary.types.review.reason).toMatch(/T-UNREADABLE-1/);
    expect(summary.types.review.reason).toMatch(/T-UNREADABLE-2/);
    // A provisional fit computed from the (empty) readable subset may be surfaced, but only under
    // a separate name, explicitly flagged as not usable -- never as the type's real estimate.
    expect(summary.types.review.provisionalFitDiagnostic).toBeTruthy();
    expect(summary.types.review.provisionalFitDiagnostic.usable).toBe(false);
  });

  it("publishes indeterminate for a type with ONE unreadable card mixed with an otherwise-readable pool", async () => {
    const listCardUsageEntriesFn = async ({ cardId }) => {
      if (cardId === "T-BAD") throw new UsageLedgerReadIndeterminateError("simulated contention");
      return Array.from({ length: 6 }, (_, i) => ({ costUsd: i + 1, complete: true, outcome: "success" }));
    };

    const summary = await buildWeeklyCalibrationSummary({
      runsDir: "/irrelevant",
      cardIdsByType: { review: ["T-GOOD", "T-BAD"] },
      fitDate: "2026-09-13T00:00:00.000Z",
      listCardUsageEntriesFn
    });

    // Reproduced defect this corrects: previously this published `value: 0.75, classification:
    // "prior", sampleCounts.review: 0` from the reduced (readable-only) pool as if it were usable.
    expect(summary.types.review.classification).toBe("indeterminate");
    expect(summary.types.review.value).toBeNull();
    expect(summary.types.review.reason).toMatch(/T-BAD/);
    expect(summary.types.review.provisionalFitDiagnostic.usable).toBe(false);
    // The provisional fit, clearly flagged unusable, may still show what the readable subset alone
    // would have produced -- it just must never masquerade as the real estimate.
    expect(summary.types.review.provisionalFitDiagnostic.estimateSource).toBe(ESTIMATE_SOURCE.EMPIRICAL);
  });
});

describe("estimateCost -- censoring survives fitting, never becomes an exact value (Codex WIP-gate batch review finding 1)", () => {
  it("an all-censored pool for a registered type never yields a determinate empirical zero", () => {
    // Reproduced defect: five {costUsd: null, complete: false, outcome: "crashed"} observations
    // used to fit as `value: 0, uncertainty: 0, classification: "empirical"` -- censored records
    // must never satisfy MIN_SAMPLES_FOR_EMPIRICAL_ESTIMATE on their own.
    const allCensored = Array.from({ length: 5 }, () => ({ censored: true, lowerBoundUsd: 0 }));
    const estimate = estimateCost({ type: "infra-large", observations: allCensored });

    expect(estimate.classification).not.toBe("empirical");
    expect(estimate).not.toEqual(expect.objectContaining({ value: 0, uncertainty: expect.objectContaining({ value: 0 }) }));
    expect(estimate.exactCount).toBe(0);
    expect(estimate.censoredCount).toBe(5);
  });

  it("an all-censored pool for an UNREGISTERED type holds for sizing instead of bypassing the fail-safe", () => {
    const allCensored = Array.from({ length: 5 }, () => ({ censored: true, lowerBoundUsd: 0 }));
    const estimate = estimateCost({ type: "unregistered-nobody-registered", observations: allCensored });

    expect(estimate.estimateSource).toBe(ESTIMATE_SOURCE.UNKNOWN_HOLD);
    expect(estimate.classification).toBe("large_hold_for_sizing");
    expect(estimate.value).toBeNull();
  });

  it("only exact observations count toward the empirical sample threshold", () => {
    // Values kept below the review prior ($0.75) so this stays a pure sample-count test, distinct
    // from the dedicated prior-raised-by-observation tests (finding 2, below).
    const fourExactOneCensored = [
      ...Array.from({ length: 4 }, () => ({ censored: false, costUsd: 0.1 })),
      { censored: true, lowerBoundUsd: 0.1 }
    ];
    // 5 total observations, but only 4 exact -- still below MIN_SAMPLES_FOR_EMPIRICAL_ESTIMATE (5).
    expect(estimateCost({ type: "review", observations: fourExactOneCensored }).estimateSource).toBe(ESTIMATE_SOURCE.PRIOR);
  });

  it("reports exact and censored counts separately in the estimate", () => {
    const observations = [
      ...Array.from({ length: 6 }, () => ({ censored: false, costUsd: 1 })),
      { censored: true, lowerBoundUsd: 0.5 }
    ];
    const estimate = estimateCost({ type: "review", observations });
    expect(estimate.exactCount).toBe(6);
    expect(estimate.censoredCount).toBe(1);
    expect(estimate.sampleCount).toBe(7);
  });

  it("when censored risk exceeds what the coverage target can support, falls back to a separately classified, still-raised estimate -- never hides it as empirical", () => {
    const mixedPool = [
      ...Array.from({ length: 5 }, () => ({ censored: false, costUsd: 1 })),
      { censored: true, lowerBoundUsd: 500 }
    ];
    const estimate = estimateCost({ type: "review", observations: mixedPool, coverageTarget: 0.9 });

    expect(estimate.classification).not.toBe("empirical");
    expect(estimate.value).toBeGreaterThanOrEqual(500);
  });
});

describe("estimateCost -- sparse-data prior never sits below proven consumption (Codex WIP-gate batch review finding 2)", () => {
  it("BELOW the empirical threshold, a $500 censored lower bound on infra-small raises the estimate above the $0.50 prior", () => {
    // Reproduced defect: infra-small with one observation censored at $500 used to still return
    // the flat $0.50 prior, discarding the proven $500 floor entirely.
    const estimate = estimateCost({ type: "infra-small", observations: [{ censored: true, lowerBoundUsd: 500 }] });

    expect(estimate.value).toBeGreaterThanOrEqual(500);
    expect(estimate.estimateSource).not.toBe(ESTIMATE_SOURCE.PRIOR);
    expect(estimate.classification).not.toBe("prior");
  });

  it("ABOVE the empirical threshold, a $500 censored lower bound on infra-small still raises the estimate above the $0.50 prior", () => {
    const observations = [...Array.from({ length: 5 }, () => ({ censored: false, costUsd: 1 })), { censored: true, lowerBoundUsd: 500 }];
    const estimate = estimateCost({ type: "infra-small", observations });

    expect(estimate.value).toBeGreaterThanOrEqual(500);
    expect(estimate.estimateSource).not.toBe(ESTIMATE_SOURCE.PRIOR);
  });

  it("below the threshold, an exact cost that's cheaper than the prior does NOT raise the estimate -- only proven consumption ABOVE the prior does", () => {
    const estimate = estimateCost({ type: "infra-large", observations: [{ censored: false, costUsd: 0.01 }] });
    expect(estimate.estimateSource).toBe(ESTIMATE_SOURCE.PRIOR);
    expect(estimate.value).toBe(TYPE_PRIORS["infra-large"].value);
  });
});

describe("observationFromAttemptEntry -- outcome decides exactness, fail-safe (Codex WIP-gate batch review finding 3)", () => {
  it("a terminal quota-stop with complete:true and a known cost is a LOWER BOUND, not exact (real runOrchestrator.js shape)", () => {
    // Reproduced defect: {costUsd: 1.42, complete: true, outcome: "quota_stop", ...} used to be
    // treated as an exact observation -- "complete" only means the phase process ended, not that
    // the recorded cost was the true final cost of successful work.
    const obs = observationFromAttemptEntry({
      costUsd: 1.42,
      complete: true,
      outcome: "quota_stop",
      terminalReason: "api_error",
      apiErrorStatus: 429
    });
    expect(obs).toEqual({ censored: true, lowerBoundUsd: 1.42 });
  });

  it("a reviewer failure with complete:true is a LOWER BOUND, not exact (real runOrchestrator.js shape)", () => {
    const obs = observationFromAttemptEntry({ costUsd: 0.8, complete: true, outcome: "reviewer_fail" });
    expect(obs).toEqual({ censored: true, lowerBoundUsd: 0.8 });
  });

  it("phase_timeout, cancelled, crashed, and in_progress are all lower bounds even with a known cost", () => {
    for (const outcome of ["phase_timeout", "cancelled", "crashed", "in_progress"]) {
      const obs = observationFromAttemptEntry({ costUsd: 3.3, complete: outcome === "in_progress" ? false : false, outcome });
      expect(obs).toEqual({ censored: true, lowerBoundUsd: 3.3 });
    }
  });

  it("fail-safe: an outcome this module has never seen before is a lower bound, not exact", () => {
    const obs = observationFromAttemptEntry({ costUsd: 9.9, complete: true, outcome: "some_future_outcome_not_yet_invented" });
    expect(obs).toEqual({ censored: true, lowerBoundUsd: 9.9 });
  });

  it("only an explicitly successful outcome with complete:true and a known cost is exact", () => {
    const obs = observationFromAttemptEntry({ costUsd: 2.5, complete: true, outcome: "success" });
    expect(obs).toEqual({ censored: false, costUsd: 2.5 });
  });
});

describe("end-to-end: unknown-cost ledger entries through collection + estimateCost never yield a determinate estimate the data can't support (Codex WIP-gate batch review)", () => {
  it("an all-censored pool (crashed/quota-stopped) for a registered type yields the type's prior, not an empirical zero", async () => {
    const listCardUsageEntriesFn = async () =>
      Array.from({ length: 5 }, () => ({ costUsd: null, complete: false, outcome: "crashed" }));

    const { observations } = await collectObservationsFromLedger({
      runsDir: "/irrelevant",
      cardIds: ["T-CRASHY"],
      listCardUsageEntriesFn
    });
    const estimate = estimateCost({ type: "infra-large", observations });

    expect(estimate.classification).not.toBe("empirical");
    expect(estimate.value).toBe(TYPE_PRIORS["infra-large"].value);
    expect(estimate.estimateSource).toBe(ESTIMATE_SOURCE.PRIOR);
  });

  it("a mixed pool (some exact successes, one expensive quota-stop) yields a raised, separately classified fallback -- not empirical", async () => {
    const listCardUsageEntriesFn = async () => [
      ...Array.from({ length: 5 }, () => ({ costUsd: 1, complete: true, outcome: "success" })),
      { costUsd: 500, complete: true, outcome: "quota_stop", terminalReason: "api_error", apiErrorStatus: 429 }
    ];

    const { observations } = await collectObservationsFromLedger({
      runsDir: "/irrelevant",
      cardIds: ["T-MIXED"],
      listCardUsageEntriesFn
    });
    const estimate = estimateCost({ type: "infra-small", observations, coverageTarget: 0.9 });

    expect(estimate.classification).not.toBe("empirical");
    expect(estimate.value).toBeGreaterThanOrEqual(500);
    expect(estimate.censoredCount).toBe(1);
    expect(estimate.exactCount).toBe(5);
  });

  it("an unregistered type with no usable data holds for sizing -- never a numeric guess", async () => {
    const listCardUsageEntriesFn = async () => [];
    const { observations } = await collectObservationsFromLedger({
      runsDir: "/irrelevant",
      cardIds: ["T-NEW-TYPE"],
      listCardUsageEntriesFn
    });
    const estimate = estimateCost({ type: "totally-unregistered-type", observations });

    expect(estimate.estimateSource).toBe(ESTIMATE_SOURCE.UNKNOWN_HOLD);
    expect(estimate.classification).toBe("large_hold_for_sizing");
    expect(estimate.value).toBeNull();
  });
});
