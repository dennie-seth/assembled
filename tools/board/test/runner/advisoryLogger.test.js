import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { READING_STATUS } from "../../src/runner/usageTelemetry.js";
import { UsageLedgerReadIndeterminateError } from "../../src/runner/usageLedger.js";
import { ESTIMATOR_VERSION, ESTIMATE_SOURCE, TYPE_PRIORS } from "../../src/runner/costEstimator.js";
import {
  classifyWindowCapacity,
  buildTelemetryFreshness,
  recordAdvisoryDecision,
  recordAdvisoryOutcome,
  withAdvisoryLogging,
  decideLaunchAdvisory,
  measureRecordedCoverage,
  advisoryLogPath
} from "../../src/runner/advisoryLogger.js";

let runsDir;

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "advisory-logger-test-"));
});

afterEach(async () => {
  await fs.rm(runsDir, { recursive: true, force: true });
});

function reading(overrides) {
  return {
    windowKind: "five_hour",
    classification: READING_STATUS.MEASURED,
    utilization: 0.4,
    status: "allowed",
    resetElapsed: false,
    ...overrides
  };
}

describe("classifyWindowCapacity / buildTelemetryFreshness -- consumer contract 3", () => {
  it("only a `measured` reading counts as verified available capacity", () => {
    const measured = classifyWindowCapacity(reading({ classification: READING_STATUS.MEASURED, utilization: 0.3 }));
    expect(measured.verifiedAvailable).toBe(true);
    expect(measured.classification).toBe("measured");
  });

  it("a status-only `allowed` reading is recorded as estimated, never as verified headroom", () => {
    const statusOnlyAllowed = classifyWindowCapacity(
      reading({ classification: READING_STATUS.ESTIMATED, utilization: 0, status: "allowed", resetElapsed: false })
    );
    expect(statusOnlyAllowed.classification).toBe("estimated");
    expect(statusOnlyAllowed.verifiedAvailable).toBe(false);
  });

  it("an elapsed-reset reading is recorded as estimated, never as verified headroom", () => {
    const elapsedReset = classifyWindowCapacity(reading({ classification: READING_STATUS.ESTIMATED, utilization: 0, resetElapsed: true }));
    expect(elapsedReset.classification).toBe("estimated");
    expect(elapsedReset.verifiedAvailable).toBe(false);
  });

  it("stale and unavailable readings are never treated as verified capacity either", () => {
    const stale = classifyWindowCapacity(reading({ classification: READING_STATUS.STALE, utilization: null }));
    const unavailable = classifyWindowCapacity(reading({ classification: READING_STATUS.UNAVAILABLE, utilization: null }));
    expect(stale.verifiedAvailable).toBe(false);
    expect(unavailable.verifiedAvailable).toBe(false);
  });

  it("carries every window's own classification through buildTelemetryFreshness", () => {
    const freshness = buildTelemetryFreshness({
      five_hour: reading({ windowKind: "five_hour", classification: READING_STATUS.MEASURED }),
      seven_day: reading({ windowKind: "seven_day", classification: READING_STATUS.STALE, utilization: null })
    });
    expect(freshness.five_hour.classification).toBe("measured");
    expect(freshness.seven_day.classification).toBe("stale");
    expect(freshness.seven_day.verifiedAvailable).toBe(false);
  });
});

const SAMPLE_ESTIMATE = Object.freeze({
  value: 1.23,
  unit: "usd",
  estimateSource: ESTIMATE_SOURCE.EMPIRICAL,
  estimatorVersion: ESTIMATOR_VERSION,
  coverageTarget: 0.9,
  uncertainty: { measure: "stddev", value: 0.4, z: 1 }
});

const SAMPLE_TELEMETRY = Object.freeze({
  five_hour: reading({ windowKind: "five_hour" }),
  seven_day: reading({ windowKind: "seven_day" })
});

describe("recordAdvisoryDecision -- acceptance 6", () => {
  it("records prediction, telemetry freshness, estimator version, and reason, with outcome pending", async () => {
    const entry = await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-1",
      invocationId: "inv-1",
      estimate: SAMPLE_ESTIMATE,
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "advisory dry run"
    });

    expect(entry.prediction).toEqual(SAMPLE_ESTIMATE);
    expect(entry.estimatorVersion).toBe(ESTIMATOR_VERSION);
    expect(entry.reason).toBe("advisory dry run");
    expect(entry.telemetryFreshness.five_hour.classification).toBe("measured");
    expect(entry.outcome).toBeNull();

    const onDisk = JSON.parse(await fs.readFile(path.join(runsDir, "T-0369-execexec-1-invinv-1.advisory.json"), "utf8"));
    expect(onDisk.cardId).toBe("T-0369");
    expect(onDisk.reason).toBe("advisory dry run");
  });
});

describe("recordAdvisoryOutcome -- eventual outcome is attached after the fact", () => {
  it("updates a previously recorded decision with its eventual outcome", async () => {
    await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-2",
      invocationId: "inv-2",
      estimate: SAMPLE_ESTIMATE,
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "advisory dry run"
    });

    const updated = await recordAdvisoryOutcome({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-2",
      invocationId: "inv-2",
      outcome: { actualCostUsd: 1.5, costKind: "exact" }
    });

    expect(updated.outcome).toEqual({ actualCostUsd: 1.5, costKind: "exact" });
    expect(updated.prediction).toEqual(SAMPLE_ESTIMATE); // the original prediction is untouched
  });

  it("refuses to attach an outcome to a decision that was never recorded", async () => {
    await expect(
      recordAdvisoryOutcome({ runsDir, cardId: "T-0369", executionId: "never", invocationId: "never", outcome: {} })
    ).rejects.toThrow(/no decision recorded/);
  });
});

describe("recordAdvisoryOutcome -- validates the outcome shape before writing (recorded coverage must fail safe)", () => {
  const MALFORMED_OUTCOMES = [
    ["null cost", { actualCostUsd: null, costKind: "exact" }],
    ["numeric-string cost", { actualCostUsd: "12", costKind: "exact" }],
    ["missing costKind", { actualCostUsd: 2 }],
    ["unknown costKind", { actualCostUsd: 2, costKind: "something_new" }],
    ["negative cost", { actualCostUsd: -5, costKind: "exact" }],
    ["non-finite cost", { actualCostUsd: Infinity, costKind: "lower_bound" }],
    ["empty object", {}]
  ];

  it.each(MALFORMED_OUTCOMES)("rejects %s and writes nothing", async (_label, outcome) => {
    await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-malformed",
      invocationId: "inv-1",
      estimate: SAMPLE_ESTIMATE,
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "advisory dry run"
    });

    await expect(
      recordAdvisoryOutcome({ runsDir, cardId: "T-0369", executionId: "exec-malformed", invocationId: "inv-1", outcome })
    ).rejects.toThrow();

    const onDisk = JSON.parse(
      await fs.readFile(advisoryLogPath(runsDir, { cardId: "T-0369", executionId: "exec-malformed", invocationId: "inv-1" }), "utf8")
    );
    expect(onDisk.outcome).toBeNull();
    expect(onDisk.prediction).toEqual(SAMPLE_ESTIMATE);
  });

  it("accepts a valid lower_bound outcome", async () => {
    await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-valid-lb",
      invocationId: "inv-1",
      estimate: SAMPLE_ESTIMATE,
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "advisory dry run"
    });
    const updated = await recordAdvisoryOutcome({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-valid-lb",
      invocationId: "inv-1",
      outcome: { actualCostUsd: 3, costKind: "lower_bound" }
    });
    expect(updated.outcome).toEqual({ actualCostUsd: 3, costKind: "lower_bound" });
  });
});

describe("decideLaunchAdvisory -- consumer contract 1 wired into the advisory logger itself", () => {
  const readUsageTelemetryFn = async () => SAMPLE_TELEMETRY;

  it("preserves an indeterminate ledger read as explicit indeterminate consumption, never zero or empty", async () => {
    const listCardUsageEntriesFn = async () => {
      throw new UsageLedgerReadIndeterminateError("simulated persistent contention");
    };

    const decision = await decideLaunchAdvisory({
      runsDir: "/irrelevant",
      cardId: "T-0369",
      type: "infra-small",
      listCardUsageEntriesFn,
      readUsageTelemetryFn
    });

    expect(decision.estimate.value).toBeNull();
    expect(decision.estimate.classification).toBe("indeterminate");
    expect(decision.estimate.consumption).toBe("indeterminate");
    // Never presented as "no usage" (which would read as a confident zero-cost estimate).
    expect(decision.estimate.value).not.toBe(0);
    expect(decision.reason).toMatch(/indeterminate/i);
    expect(decision.reason).toMatch(/T-0369/);
  });

  it("re-throws any other ledger read error unchanged", async () => {
    const listCardUsageEntriesFn = async () => {
      throw new Error("unrelated disk failure");
    };
    await expect(
      decideLaunchAdvisory({ runsDir: "/irrelevant", cardId: "T-0369", type: "infra-small", listCardUsageEntriesFn, readUsageTelemetryFn })
    ).rejects.toThrow("unrelated disk failure");
  });

  it("builds a real estimate from the card's own ledger history on the happy path", async () => {
    // Values kept below the infra-small prior ($0.50) so this stays a plain "below MIN_SAMPLES ->
    // prior" happy path, distinct from the dedicated prior-raised-by-observation tests.
    const listCardUsageEntriesFn = async () => [
      { costUsd: 0.1, complete: true, outcome: "success" },
      { costUsd: 0.2, complete: true, outcome: "success" }
    ];
    const decision = await decideLaunchAdvisory({
      runsDir: "/irrelevant",
      cardId: "T-0369",
      type: "infra-small",
      listCardUsageEntriesFn,
      readUsageTelemetryFn
    });
    expect(decision.estimate.estimateSource).toBe(ESTIMATE_SOURCE.PRIOR); // below MIN_SAMPLES
    expect(decision.reason).not.toMatch(/indeterminate/i);
  });

  it("an indeterminate decision can still be persisted and never blocks launch via withAdvisoryLogging", async () => {
    const listCardUsageEntriesFn = async () => {
      throw new UsageLedgerReadIndeterminateError("boom");
    };
    const decide = async () => {
      const decision = await decideLaunchAdvisory({
        runsDir,
        cardId: "T-0369",
        type: "infra-small",
        listCardUsageEntriesFn,
        readUsageTelemetryFn
      });
      return recordAdvisoryDecision({
        runsDir,
        cardId: "T-0369",
        executionId: "exec-indeterminate",
        invocationId: "inv-1",
        estimate: decision.estimate,
        telemetryReadings: decision.telemetryReadings,
        reason: decision.reason
      });
    };
    const launch = async () => "LAUNCHED";

    const { advisory, result } = await withAdvisoryLogging({ decide, launch });

    expect(result).toBe("LAUNCHED");
    expect(advisory.prediction.classification).toBe("indeterminate");
    expect(advisory.reason).toMatch(/indeterminate/i);
  });
});

describe("withAdvisoryLogging -- proves the logger changes no launch (acceptance 6)", () => {
  it("still launches when the advisory decision throws outright", async () => {
    const launch = async () => "LAUNCHED";
    const decide = async () => {
      throw new Error("advisory subsystem is down");
    };
    const { result } = await withAdvisoryLogging({ decide, launch });
    expect(result).toBe("LAUNCHED");
  });

  it("launch's result is identical regardless of how alarming the advisory prediction is", async () => {
    const launch = async () => ({ launched: true, cardId: "T-0369" });
    const alarmingDecide = async () => ({
      prediction: { value: null, estimateSource: ESTIMATE_SOURCE.UNKNOWN_HOLD, classification: "large_hold_for_sizing" },
      telemetryFreshness: { five_hour: { classification: "unavailable", verifiedAvailable: false } }
    });
    const calmDecide = async () => ({ prediction: SAMPLE_ESTIMATE, telemetryFreshness: {} });

    const alarming = await withAdvisoryLogging({ decide: alarmingDecide, launch });
    const calm = await withAdvisoryLogging({ decide: calmDecide, launch });

    expect(alarming.result).toEqual(calm.result);
    expect(alarming.result).toEqual({ launched: true, cardId: "T-0369" });
  });

  it("surfaces the advisory entry alongside the launch result when logging succeeds", async () => {
    const launch = async () => "LAUNCHED";
    const decide = async () => ({ reason: "ok" });
    const { advisory, result } = await withAdvisoryLogging({ decide, launch });
    expect(advisory).toEqual({ reason: "ok" });
    expect(result).toBe("LAUNCHED");
  });
});

describe("recordAdvisoryDecision -- carries the fit identity its prediction came from (Codex WIP-gate batch review finding 6)", () => {
  it("persists type and fitDate alongside the prediction so coverage can be grouped by them later", async () => {
    const entry = await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-fit",
      invocationId: "inv-fit",
      type: "infra-small",
      fitDate: "2026-09-13",
      estimate: SAMPLE_ESTIMATE,
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "advisory dry run"
    });

    expect(entry.type).toBe("infra-small");
    expect(entry.fitDate).toBe("2026-09-13");
    expect(entry.estimatorVersion).toBe(ESTIMATOR_VERSION);
  });

  it("decideLaunchAdvisory passes the type and fitDate it was given through to its returned decision", async () => {
    const decision = await decideLaunchAdvisory({
      runsDir: "/irrelevant",
      cardId: "T-0369",
      type: "infra-small",
      fitDate: "2026-09-13",
      listCardUsageEntriesFn: async () => [],
      readUsageTelemetryFn: async () => SAMPLE_TELEMETRY
    });
    expect(decision.type).toBe("infra-small");
    expect(decision.fitDate).toBe("2026-09-13");
  });
});

describe("measureRecordedCoverage -- coverage measures realized outcomes against recorded pre-launch predictions (Codex WIP-gate batch review finding 6)", () => {
  async function recordAndResolve({ executionId, predictionValue, actualCostUsd, costKind = "exact", estimatorVersion = ESTIMATOR_VERSION, fitDate = "2026-09-13" }) {
    await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId,
      invocationId: "inv-1",
      type: "infra-small",
      fitDate,
      estimate: { ...SAMPLE_ESTIMATE, value: predictionValue, estimatorVersion },
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "test fixture"
    });
    return recordAdvisoryOutcome({
      runsDir,
      cardId: "T-0369",
      executionId,
      invocationId: "inv-1",
      outcome: { actualCostUsd, costKind }
    });
  }

  it("reports all five as overruns for a fixture of five recorded $1 predictions with $10 actual costs", async () => {
    for (let i = 0; i < 5; i += 1) {
      await recordAndResolve({ executionId: `exec-overrun-${i}`, predictionValue: 1, actualCostUsd: 10 });
    }

    const { groups } = await measureRecordedCoverage({ runsDir });
    const group = groups[`${ESTIMATOR_VERSION}::2026-09-13`];
    expect(group.evaluated).toBe(5);
    expect(group.exceeded).toBe(5);
    expect(group.fraction).toBe(1);
  });

  it("recording an outcome never alters the recorded prediction itself", async () => {
    await recordAndResolve({ executionId: "exec-immutable", predictionValue: 1, actualCostUsd: 10 });
    const onDisk = JSON.parse(
      await fs.readFile(path.join(runsDir, "T-0369-execexec-immutable-invinv-1.advisory.json"), "utf8")
    );
    expect(onDisk.prediction.value).toBe(1);
    expect(onDisk.outcome.actualCostUsd).toBe(10);
  });

  it("groups separately by estimator version and fit identity", async () => {
    await recordAndResolve({ executionId: "exec-v1", predictionValue: 1, actualCostUsd: 10, estimatorVersion: "v1", fitDate: "2026-09-13" });
    await recordAndResolve({ executionId: "exec-v2", predictionValue: 1, actualCostUsd: 10, estimatorVersion: "v2", fitDate: "2026-09-20" });

    const { groups } = await measureRecordedCoverage({ runsDir });
    expect(groups["v1::2026-09-13"].evaluated).toBe(1);
    expect(groups["v2::2026-09-20"].evaluated).toBe(1);
  });

  it("a censored (lower-bound) actual above the prediction is a proven overrun", async () => {
    await recordAndResolve({ executionId: "exec-lb-over", predictionValue: 1, actualCostUsd: 5, costKind: "lower_bound" });
    const { groups } = await measureRecordedCoverage({ runsDir });
    const group = groups[`${ESTIMATOR_VERSION}::2026-09-13`];
    expect(group.evaluated).toBe(1);
    expect(group.exceeded).toBe(1);
  });

  it("a censored (lower-bound) actual below the prediction is unresolved -- never counted as a proven non-overrun", async () => {
    await recordAndResolve({ executionId: "exec-lb-under", predictionValue: 100, actualCostUsd: 5, costKind: "lower_bound" });
    const { groups } = await measureRecordedCoverage({ runsDir });
    const group = groups[`${ESTIMATOR_VERSION}::2026-09-13`];
    expect(group.evaluated).toBe(0);
    expect(group.unresolved).toBe(1);
  });

  it("excludes records with an indeterminate/null prediction from scoring, counted separately", async () => {
    await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-indet",
      invocationId: "inv-1",
      type: "infra-small",
      fitDate: "2026-09-13",
      estimate: { value: null, classification: "indeterminate", consumption: "indeterminate", estimatorVersion: ESTIMATOR_VERSION },
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "ledger read indeterminate"
    });
    await recordAdvisoryOutcome({ runsDir, cardId: "T-0369", executionId: "exec-indet", invocationId: "inv-1", outcome: { actualCostUsd: 5, costKind: "exact" } });

    const { groups, excludedIndeterminate } = await measureRecordedCoverage({ runsDir });
    expect(excludedIndeterminate).toBe(1);
    expect(Object.values(groups).some((g) => g.evaluated > 0)).toBe(false);
  });

  it("a record with no outcome yet (pending) is not scored", async () => {
    await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-pending",
      invocationId: "inv-1",
      type: "infra-small",
      fitDate: "2026-09-13",
      estimate: SAMPLE_ESTIMATE,
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "test fixture"
    });

    const { groups, pending } = await measureRecordedCoverage({ runsDir });
    expect(pending).toBe(1);
    expect(Object.keys(groups)).toHaveLength(0);
  });
});

describe("measureRecordedCoverage -- fails safe on malformed outcomes and corrupt record files (recorded coverage fail-safe round)", () => {
  // Writes an outcome directly to disk, bypassing recordAdvisoryOutcome's validation, to simulate
  // an older or hand-written record file the reader must still tolerate.
  async function recordWithRawOutcome({ executionId, predictionValue = 5, outcome, fitDate = "2026-09-13" }) {
    await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId,
      invocationId: "inv-1",
      type: "infra-small",
      fitDate,
      estimate: { ...SAMPLE_ESTIMATE, value: predictionValue },
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "test fixture"
    });
    const filePath = advisoryLogPath(runsDir, { cardId: "T-0369", executionId, invocationId: "inv-1" });
    const existing = JSON.parse(await fs.readFile(filePath, "utf8"));
    await fs.writeFile(filePath, JSON.stringify({ ...existing, outcome }), "utf8");
  }

  const MALFORMED_OUTCOMES = [
    ["null cost", { actualCostUsd: null, costKind: "exact" }],
    ["numeric-string cost", { actualCostUsd: "12", costKind: "exact" }],
    ["missing costKind", { actualCostUsd: 2 }],
    ["unknown costKind", { actualCostUsd: 2, costKind: "something_new" }],
    ["negative cost", { actualCostUsd: -5, costKind: "exact" }]
  ];

  it("reports all five malformed outcomes as unresolved, never moving evaluated/exceeded, fraction null", async () => {
    for (const [i, [, outcome]] of MALFORMED_OUTCOMES.entries()) {
      await recordWithRawOutcome({ executionId: `exec-bad-${i}`, predictionValue: 5, outcome });
    }

    const { groups } = await measureRecordedCoverage({ runsDir });
    const group = groups[`${ESTIMATOR_VERSION}::2026-09-13`];
    expect(group.evaluated).toBe(0);
    expect(group.exceeded).toBe(0);
    expect(group.unresolved).toBe(5);
    expect(group.fraction).toBeNull();
  });

  it("a mixed fixture scores the valid records exactly as before, malformed ones unresolved", async () => {
    for (let i = 0; i < 3; i += 1) {
      await recordWithRawOutcome({ executionId: `exec-valid-${i}`, predictionValue: 1, outcome: { actualCostUsd: 10, costKind: "exact" } });
    }
    for (const [i, [, outcome]] of MALFORMED_OUTCOMES.entries()) {
      await recordWithRawOutcome({ executionId: `exec-bad-mixed-${i}`, predictionValue: 1, outcome });
    }

    const { groups } = await measureRecordedCoverage({ runsDir });
    const group = groups[`${ESTIMATOR_VERSION}::2026-09-13`];
    expect(group.evaluated).toBe(3);
    expect(group.exceeded).toBe(3);
    expect(group.unresolved).toBe(5);
    expect(group.fraction).toBe(1);
  });

  it("a corrupt record file beside valid ones leaves the valid records' result identical, and is counted in a top-level tally", async () => {
    for (let i = 0; i < 3; i += 1) {
      await recordWithRawOutcome({ executionId: `exec-corrupt-baseline-${i}`, predictionValue: 1, outcome: { actualCostUsd: 10, costKind: "exact" } });
    }
    const { groups: before } = await measureRecordedCoverage({ runsDir });

    await fs.writeFile(path.join(runsDir, "T-0369-execcorrupt-invinv-1.advisory.json"), '{"trunc', "utf8");

    const { groups: after, unreadable } = await measureRecordedCoverage({ runsDir });
    expect(after).toEqual(before);
    expect(unreadable).toBe(1);
  });
});

describe("measureRecordedCoverage -- a record file that parses but is not a plain object goes to unreadable, never crashes, never counts as pending", () => {
  const ODD_CONTENTS = [
    ["null", "null"],
    ["an array", "[]"],
    ["a bare number", "42"],
    ["a bare string", '"x"']
  ];

  for (const [label, raw] of ODD_CONTENTS) {
    it(`a file containing exactly ${label} beside a valid record leaves the valid record's result identical and raises unreadable by one`, async () => {
      await recordAdvisoryDecision({
        runsDir,
        cardId: "T-0369",
        executionId: "exec-oddbaseline",
        invocationId: "inv-1",
        type: "infra-small",
        fitDate: "2026-09-13",
        estimate: { ...SAMPLE_ESTIMATE, value: 1 },
        telemetryReadings: SAMPLE_TELEMETRY,
        reason: "test fixture"
      });
      await recordAdvisoryOutcome({
        runsDir,
        cardId: "T-0369",
        executionId: "exec-oddbaseline",
        invocationId: "inv-1",
        outcome: { actualCostUsd: 10, costKind: "exact" }
      });

      const { groups: before } = await measureRecordedCoverage({ runsDir });

      await fs.writeFile(path.join(runsDir, "T-0369-execodd-invinv-1.advisory.json"), raw, "utf8");

      const { groups: after, unreadable, pending } = await measureRecordedCoverage({ runsDir });
      expect(after).toEqual(before);
      expect(unreadable).toBe(1);
      expect(pending).toBe(0);
    });
  }

  it("does not throw on a null-content file and still scores the valid record", async () => {
    await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-nullthrow",
      invocationId: "inv-1",
      type: "infra-small",
      fitDate: "2026-09-13",
      estimate: { ...SAMPLE_ESTIMATE, value: 1 },
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "test fixture"
    });
    await recordAdvisoryOutcome({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-nullthrow",
      invocationId: "inv-1",
      outcome: { actualCostUsd: 10, costKind: "exact" }
    });
    await fs.writeFile(path.join(runsDir, "T-0369-execnull-invinv-1.advisory.json"), "null", "utf8");

    await expect(measureRecordedCoverage({ runsDir })).resolves.toBeTruthy();
    const { groups, unreadable } = await measureRecordedCoverage({ runsDir });
    const group = groups[`${ESTIMATOR_VERSION}::2026-09-13`];
    expect(group.evaluated).toBe(1);
    expect(group.exceeded).toBe(1);
    expect(unreadable).toBe(1);
  });

  it("a record that parses to a plain object keeps today's handling unchanged", async () => {
    await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-plainobj-pending",
      invocationId: "inv-1",
      type: "infra-small",
      fitDate: "2026-09-13",
      estimate: { ...SAMPLE_ESTIMATE, value: 1 },
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "test fixture"
    });

    const { pending, unreadable } = await measureRecordedCoverage({ runsDir });
    expect(pending).toBe(1);
    expect(unreadable).toBe(0);
  });
});

describe("measureRecordedCoverage -- validates prediction.value before scoring (Codex review 2026-09-14)", () => {
  const INVALID_PREDICTION_VALUES = [
    ["a non-numeric string", "not-a-number"],
    ["a numeric string", "100"],
    ["a negative number", -1],
    ["Infinity (JSON 1e400)", Infinity]
  ];

  async function recordRawPrediction({ executionId, predictionValue, outcome = { costKind: "exact", actualCostUsd: 10 } }) {
    await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId,
      invocationId: "inv-1",
      type: "infra-small",
      fitDate: "2026-09-13",
      estimate: { ...SAMPLE_ESTIMATE, value: 1 },
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "test fixture"
    });
    const filePath = advisoryLogPath(runsDir, { cardId: "T-0369", executionId, invocationId: "inv-1" });
    const existing = JSON.parse(await fs.readFile(filePath, "utf8"));
    await fs.writeFile(
      filePath,
      JSON.stringify({ ...existing, prediction: { ...existing.prediction, value: predictionValue }, outcome }),
      "utf8"
    );
  }

  it.each(INVALID_PREDICTION_VALUES)("a record whose prediction.value is %s is reported invalid, never scored", async (_label, predictionValue) => {
    await recordRawPrediction({ executionId: "exec-invalid-pred", predictionValue });

    const { groups, invalidPrediction } = await measureRecordedCoverage({ runsDir });
    expect(invalidPrediction).toBe(1);
    expect(Object.values(groups).some((g) => g.evaluated > 0 || g.exceeded > 0)).toBe(false);
  });

  it("a mixed fixture: invalid predictions never move the valid records' evaluated/exceeded/fraction", async () => {
    for (let i = 0; i < 5; i += 1) {
      await recordAndResolve({ executionId: `exec-valid-pred-${i}`, predictionValue: 1, actualCostUsd: 10 });
    }
    for (const [i, [, predictionValue]] of INVALID_PREDICTION_VALUES.entries()) {
      await recordRawPrediction({ executionId: `exec-invalid-pred-mixed-${i}`, predictionValue });
    }

    const { groups, invalidPrediction } = await measureRecordedCoverage({ runsDir });
    const group = groups[`${ESTIMATOR_VERSION}::2026-09-13`];
    expect(group.evaluated).toBe(5);
    expect(group.exceeded).toBe(5);
    expect(group.fraction).toBe(1);
    expect(invalidPrediction).toBe(4);
  });

  it("a null prediction still counts as excludedIndeterminate, not invalidPrediction", async () => {
    await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-null-pred",
      invocationId: "inv-1",
      type: "infra-small",
      fitDate: "2026-09-13",
      estimate: { value: null, classification: "indeterminate", consumption: "indeterminate", estimatorVersion: ESTIMATOR_VERSION },
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "ledger read indeterminate"
    });
    await recordAdvisoryOutcome({ runsDir, cardId: "T-0369", executionId: "exec-null-pred", invocationId: "inv-1", outcome: { actualCostUsd: 5, costKind: "exact" } });

    const { excludedIndeterminate, invalidPrediction } = await measureRecordedCoverage({ runsDir });
    expect(excludedIndeterminate).toBe(1);
    expect(invalidPrediction).toBe(0);
  });

  // Local helper mirroring the earlier describe block's recordAndResolve, since it's scoped there.
  async function recordAndResolve({ executionId, predictionValue, actualCostUsd, costKind = "exact", estimatorVersion = ESTIMATOR_VERSION, fitDate = "2026-09-13" }) {
    await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId,
      invocationId: "inv-1",
      type: "infra-small",
      fitDate,
      estimate: { ...SAMPLE_ESTIMATE, value: predictionValue, estimatorVersion },
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "test fixture"
    });
    return recordAdvisoryOutcome({
      runsDir,
      cardId: "T-0369",
      executionId,
      invocationId: "inv-1",
      outcome: { actualCostUsd, costKind }
    });
  }
});

describe("measureRecordedCoverage -- only a missing outcome is pending; false/0/\"\" are unresolved (Codex review 2026-09-14)", () => {
  const FALSY_NON_MISSING_OUTCOMES = [
    ["false", false],
    ["0", 0],
    ["empty string", ""]
  ];

  async function recordRawOutcome({ executionId, outcome }) {
    await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId,
      invocationId: "inv-1",
      type: "infra-small",
      fitDate: "2026-09-13",
      estimate: { ...SAMPLE_ESTIMATE, value: 1 },
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "test fixture"
    });
    const filePath = advisoryLogPath(runsDir, { cardId: "T-0369", executionId, invocationId: "inv-1" });
    const existing = JSON.parse(await fs.readFile(filePath, "utf8"));
    await fs.writeFile(filePath, JSON.stringify({ ...existing, outcome }), "utf8");
  }

  it.each(FALSY_NON_MISSING_OUTCOMES)("a record whose outcome is %s is counted unresolved, not pending", async (_label, outcome) => {
    await recordRawOutcome({ executionId: "exec-falsy-outcome", outcome });

    const { groups, pending } = await measureRecordedCoverage({ runsDir });
    expect(pending).toBe(0);
    const group = groups[`${ESTIMATOR_VERSION}::2026-09-13`];
    expect(group.unresolved).toBe(1);
    expect(group.evaluated).toBe(0);
  });

  it("a genuinely missing outcome (undefined key) is still pending", async () => {
    await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-truly-pending",
      invocationId: "inv-1",
      type: "infra-small",
      fitDate: "2026-09-13",
      estimate: { ...SAMPLE_ESTIMATE, value: 1 },
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "test fixture"
    });

    const { pending, groups } = await measureRecordedCoverage({ runsDir });
    expect(pending).toBe(1);
    expect(Object.keys(groups)).toHaveLength(0);
  });
});

describe("recordAdvisoryDecision -- rejects a malformed prediction value before writing (Codex review 2026-09-14)", () => {
  const INVALID_PREDICTION_VALUES = [
    ["a non-numeric string", "not-a-number"],
    ["a numeric string", "100"],
    ["a negative number", -1],
    ["Infinity", Infinity],
    ["NaN", NaN],
    ["missing value", undefined]
  ];

  it.each(INVALID_PREDICTION_VALUES)("rejects estimate.value = %s and writes nothing", async (_label, value) => {
    const estimate = { ...SAMPLE_ESTIMATE, value };
    await expect(
      recordAdvisoryDecision({
        runsDir,
        cardId: "T-0369",
        executionId: "exec-bad-prediction",
        invocationId: "inv-1",
        type: "infra-small",
        fitDate: "2026-09-13",
        estimate,
        telemetryReadings: SAMPLE_TELEMETRY,
        reason: "test fixture"
      })
    ).rejects.toThrow();

    await expect(
      fs.readFile(advisoryLogPath(runsDir, { cardId: "T-0369", executionId: "exec-bad-prediction", invocationId: "inv-1" }), "utf8")
    ).rejects.toThrow();
  });

  it("still records a valid null value (hold-for-sizing / indeterminate)", async () => {
    const entry = await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-null-value-ok",
      invocationId: "inv-1",
      type: "infra-small",
      fitDate: "2026-09-13",
      estimate: { value: null, classification: "large_hold_for_sizing", estimatorVersion: ESTIMATOR_VERSION },
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "no data"
    });
    expect(entry.prediction.value).toBeNull();
  });

  it("still records a valid finite non-negative numeric value", async () => {
    const entry = await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-valid-value-ok",
      invocationId: "inv-1",
      type: "infra-small",
      fitDate: "2026-09-13",
      estimate: { ...SAMPLE_ESTIMATE, value: 0 },
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "zero is valid"
    });
    expect(entry.prediction.value).toBe(0);
  });
});

describe("end-to-end: unknown-cost ledger entries through collection, estimateCost, and the advisory record (Codex WIP-gate batch review)", () => {
  const readUsageTelemetryFn = async () => SAMPLE_TELEMETRY;

  it("an all-censored pool for a registered type produces a persisted prior, not a determinate empirical estimate the data can't support", async () => {
    const listCardUsageEntriesFn = async () =>
      Array.from({ length: 5 }, () => ({ costUsd: null, complete: false, outcome: "crashed" }));

    const decision = await decideLaunchAdvisory({
      runsDir: "/irrelevant",
      cardId: "T-0369",
      type: "infra-large",
      listCardUsageEntriesFn,
      readUsageTelemetryFn
    });
    const record = await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-e2e-censored",
      invocationId: "inv-1",
      type: decision.type,
      estimate: decision.estimate,
      telemetryReadings: decision.telemetryReadings,
      reason: decision.reason
    });

    expect(record.prediction.classification).not.toBe("empirical");
    expect(record.prediction.value).toBe(TYPE_PRIORS["infra-large"].value);
  });

  it("a mixed pool (exact successes plus one expensive quota-stop) produces a raised, separately classified persisted prediction", async () => {
    const listCardUsageEntriesFn = async () => [
      ...Array.from({ length: 5 }, () => ({ costUsd: 1, complete: true, outcome: "success" })),
      { costUsd: 500, complete: true, outcome: "quota_stop", terminalReason: "api_error", apiErrorStatus: 429 }
    ];

    const decision = await decideLaunchAdvisory({
      runsDir: "/irrelevant",
      cardId: "T-0369",
      type: "infra-small",
      listCardUsageEntriesFn,
      readUsageTelemetryFn
    });
    const record = await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-e2e-mixed",
      invocationId: "inv-1",
      type: decision.type,
      estimate: decision.estimate,
      telemetryReadings: decision.telemetryReadings,
      reason: decision.reason
    });

    expect(record.prediction.classification).not.toBe("empirical");
    expect(record.prediction.value).toBeGreaterThanOrEqual(500);
  });

  it("an unregistered type with no usable data produces a persisted hold-for-sizing prediction, never a numeric guess", async () => {
    const listCardUsageEntriesFn = async () => [];

    const decision = await decideLaunchAdvisory({
      runsDir: "/irrelevant",
      cardId: "T-0369",
      type: "totally-unregistered-type",
      listCardUsageEntriesFn,
      readUsageTelemetryFn
    });
    const record = await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-e2e-unregistered",
      invocationId: "inv-1",
      type: decision.type,
      estimate: decision.estimate,
      telemetryReadings: decision.telemetryReadings,
      reason: decision.reason
    });

    expect(record.prediction.classification).toBe("large_hold_for_sizing");
    expect(record.prediction.value).toBeNull();
  });
});
