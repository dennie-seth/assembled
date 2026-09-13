import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { READING_STATUS } from "../../src/runner/usageTelemetry.js";
import { UsageLedgerReadIndeterminateError } from "../../src/runner/usageLedger.js";
import { ESTIMATOR_VERSION, ESTIMATE_SOURCE } from "../../src/runner/costEstimator.js";
import {
  classifyWindowCapacity,
  buildTelemetryFreshness,
  recordAdvisoryDecision,
  recordAdvisoryOutcome,
  withAdvisoryLogging,
  decideLaunchAdvisory
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
      outcome: { actualCostUsd: 1.5, exceededEstimate: true }
    });

    expect(updated.outcome).toEqual({ actualCostUsd: 1.5, exceededEstimate: true });
    expect(updated.prediction).toEqual(SAMPLE_ESTIMATE); // the original prediction is untouched
  });

  it("refuses to attach an outcome to a decision that was never recorded", async () => {
    await expect(
      recordAdvisoryOutcome({ runsDir, cardId: "T-0369", executionId: "never", invocationId: "never", outcome: {} })
    ).rejects.toThrow();
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
    const listCardUsageEntriesFn = async () => [
      { costUsd: 1, complete: true, outcome: "success" },
      { costUsd: 2, complete: true, outcome: "success" }
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
