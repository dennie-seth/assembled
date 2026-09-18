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
  recordManualOverride,
  withAdvisoryLogging,
  decideLaunchAdvisory,
  measureRecordedCoverage,
  advisoryLogPath,
  retainOutcomeUntilDecisionRecorded,
  pendingOutcomePath,
  AdvisoryDecisionMissingError
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

describe("recordAdvisoryDecision -- T-0370 fix round 2 finding 2: exclusive record creation, so a late write can never clobber an earlier one", () => {
  it("a second call for the same launch identity does not overwrite the first -- the first recorded decision wins", async () => {
    const first = await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-race",
      invocationId: "inv-1",
      estimate: SAMPLE_ESTIMATE,
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "first (the fallback that already landed)"
    });
    const second = await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-race",
      invocationId: "inv-1",
      estimate: { value: 9, unit: "usd" },
      telemetryReadings: {},
      reason: "second (a late write that outlived the timeout)"
    });

    expect(second.reason).toBe(first.reason);
    const onDisk = JSON.parse(await fs.readFile(advisoryLogPath(runsDir, { cardId: "T-0369", executionId: "exec-race", invocationId: "inv-1" }), "utf8"));
    expect(onDisk.reason).toBe("first (the fallback that already landed)");
  });

  it("a late write never erases an outcome already attached to the first-recorded decision", async () => {
    await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-race2",
      invocationId: "inv-1",
      estimate: SAMPLE_ESTIMATE,
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "first"
    });
    await recordAdvisoryOutcome({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-race2",
      invocationId: "inv-1",
      outcome: { actualCostUsd: 2, costKind: "exact" }
    });

    const late = await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0369",
      executionId: "exec-race2",
      invocationId: "inv-1",
      estimate: { value: 9, unit: "usd" },
      telemetryReadings: {},
      reason: "late"
    });

    expect(late.outcome).toEqual({ actualCostUsd: 2, costKind: "exact" });
    const onDisk = JSON.parse(await fs.readFile(advisoryLogPath(runsDir, { cardId: "T-0369", executionId: "exec-race2", invocationId: "inv-1" }), "utf8"));
    expect(onDisk.outcome).toEqual({ actualCostUsd: 2, costKind: "exact" });
    expect(onDisk.reason).toBe("first");
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

describe("recordManualOverride -- T-0379: marks a decision as bypassed by an operator-initiated launch", () => {
  it("attaches a manualOverride marker to a previously recorded decision, leaving the prediction untouched", async () => {
    await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0379",
      executionId: "exec-mo1",
      invocationId: "inv-1",
      estimate: SAMPLE_ESTIMATE,
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "advisory dry run"
    });

    const admission = { admitted: false, windows: { five_hour: { admitted: false, holdReason: "units_not_comparable" } } };
    const updated = await recordManualOverride({
      runsDir,
      cardId: "T-0379",
      executionId: "exec-mo1",
      invocationId: "inv-1",
      admission,
      reason: "five_hour: units_not_comparable"
    });

    expect(updated.manualOverride).toMatchObject({ reason: "five_hour: units_not_comparable", admission });
    expect(updated.manualOverride.overriddenAt).toEqual(expect.any(String));
    expect(updated.prediction).toEqual(SAMPLE_ESTIMATE);

    const onDisk = JSON.parse(await fs.readFile(advisoryLogPath(runsDir, { cardId: "T-0379", executionId: "exec-mo1", invocationId: "inv-1" }), "utf8"));
    expect(onDisk.manualOverride.reason).toBe("five_hour: units_not_comparable");
  });

  it("throws a distinguishable AdvisoryDecisionMissingError when no decision was ever recorded", async () => {
    await expect(
      recordManualOverride({ runsDir, cardId: "T-0379", executionId: "never", invocationId: "never", admission: null, reason: "n/a" })
    ).rejects.toBeInstanceOf(AdvisoryDecisionMissingError);
  });

  it("records a null admission (advisory pipeline itself unavailable) rather than throwing", async () => {
    await recordAdvisoryDecision({
      runsDir,
      cardId: "T-0379",
      executionId: "exec-mo2",
      invocationId: "inv-1",
      estimate: SAMPLE_ESTIMATE,
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "advisory dry run"
    });
    const updated = await recordManualOverride({
      runsDir,
      cardId: "T-0379",
      executionId: "exec-mo2",
      invocationId: "inv-1",
      admission: null,
      reason: "advisory decision unavailable (timeout/error) -- unknown capacity"
    });
    expect(updated.manualOverride.admission).toBeNull();
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

describe("recordAdvisoryOutcome / retainOutcomeUntilDecisionRecorded -- T-0370 round 3: a finished launch's outcome is never lost to the decision's own timing", () => {
  it("recordAdvisoryOutcome throws a distinguishable AdvisoryDecisionMissingError when no decision exists yet, not a generic Error", async () => {
    const rejection = recordAdvisoryOutcome({
      runsDir,
      cardId: "T-0370",
      executionId: "round3-missing",
      invocationId: "inv-1",
      outcome: { actualCostUsd: 1, costKind: "exact" }
    });
    await expect(rejection).rejects.toThrow(/no decision recorded/);
    await expect(rejection).rejects.toBeInstanceOf(AdvisoryDecisionMissingError);
  });

  it("outcome-before-decision: a retained outcome is attached once a decision is later recorded for the same launch identity", async () => {
    const key = { runsDir, cardId: "T-0370", executionId: "round3-outcome-first", invocationId: "inv-1" };
    await retainOutcomeUntilDecisionRecorded({ ...key, outcome: { actualCostUsd: 2.5, costKind: "lower_bound" } });

    // Nothing scoreable exists yet -- the marker is not mistaken for a decision.
    expect((await fs.readdir(runsDir)).some((f) => f.endsWith(".advisory.json") && f.includes("round3-outcome-first"))).toBe(false);

    const published = await recordAdvisoryDecision({
      ...key,
      estimate: SAMPLE_ESTIMATE,
      telemetryReadings: SAMPLE_TELEMETRY,
      reason: "published after the outcome was already retained"
    });

    expect(published.outcome).toEqual({ actualCostUsd: 2.5, costKind: "lower_bound" });
    const onDisk = JSON.parse(await fs.readFile(advisoryLogPath(runsDir, key), "utf8"));
    expect(onDisk.outcome).toEqual({ actualCostUsd: 2.5, costKind: "lower_bound" });
    // The marker is cleared once consumed -- it never outlives its use.
    await expect(fs.readFile(pendingOutcomePath(runsDir, key), "utf8")).rejects.toThrow();
  });

  it("decision-landed-concurrently: retainOutcomeUntilDecisionRecorded's own re-check attaches immediately when the decision already exists", async () => {
    const key = { runsDir, cardId: "T-0370", executionId: "round3-decision-first", invocationId: "inv-1" };
    await recordAdvisoryDecision({ ...key, estimate: SAMPLE_ESTIMATE, telemetryReadings: SAMPLE_TELEMETRY, reason: "published first" });

    const result = await retainOutcomeUntilDecisionRecorded({ ...key, outcome: { actualCostUsd: 4, costKind: "exact" } });

    expect(result.outcome).toEqual({ actualCostUsd: 4, costKind: "exact" });
    const onDisk = JSON.parse(await fs.readFile(advisoryLogPath(runsDir, key), "utf8"));
    expect(onDisk.outcome).toEqual({ actualCostUsd: 4, costKind: "exact" });
    await expect(fs.readFile(pendingOutcomePath(runsDir, key), "utf8")).rejects.toThrow();
  });

  it("a decision record that already carries an outcome is never overwritten by a stray pending marker", async () => {
    const key = { runsDir, cardId: "T-0370", executionId: "round3-already-attached", invocationId: "inv-1" };
    await recordAdvisoryDecision({ ...key, estimate: SAMPLE_ESTIMATE, telemetryReadings: SAMPLE_TELEMETRY, reason: "published" });
    await recordAdvisoryOutcome({ ...key, outcome: { actualCostUsd: 1, costKind: "exact" } });

    // A stray/late marker for the same identity, carrying a DIFFERENT outcome, must never clobber
    // the outcome already attached -- but it is still cleared, never left behind.
    await retainOutcomeUntilDecisionRecorded({ ...key, outcome: { actualCostUsd: 99, costKind: "exact" } });

    const onDisk = JSON.parse(await fs.readFile(advisoryLogPath(runsDir, key), "utf8"));
    expect(onDisk.outcome).toEqual({ actualCostUsd: 1, costKind: "exact" });
    await expect(fs.readFile(pendingOutcomePath(runsDir, key), "utf8")).rejects.toThrow();
  });

  it("a pending marker with no decision ever recorded is invisible to measureRecordedCoverage -- never counted as pending or scored", async () => {
    const key = { runsDir, cardId: "T-0370", executionId: "round3-orphan-marker", invocationId: "inv-1" };
    await retainOutcomeUntilDecisionRecorded({ ...key, outcome: { actualCostUsd: 1, costKind: "exact" } });

    const coverage = await measureRecordedCoverage({ runsDir });
    expect(coverage.pending).toBe(0);
    expect(coverage.unreadable).toBe(0);
    expect(Object.keys(coverage.groups)).toHaveLength(0);
  });
});

describe("recordAdvisoryDecision / retainOutcomeUntilDecisionRecorded -- T-0370 fix round 4 (Codex review 2026-09-17): a retained outcome survives a failed or interrupted attachment", () => {
  const PROBE_ESTIMATE = Object.freeze({ value: 1, unit: "usd", estimatorVersion: "probe" });

  it("Codex's outcome-probe.mjs: a renameFn failure during attach leaves the outcome recoverable on disk, attached on a later attempt", async () => {
    const key = { runsDir, cardId: "T-0370", executionId: "round4-failed-attach", invocationId: "inv-1" };
    await retainOutcomeUntilDecisionRecorded({ ...key, outcome: { actualCostUsd: 2, costKind: "exact" } });

    const before = await fs.readdir(runsDir);
    expect(before.some((f) => f.includes("round4-failed-attach"))).toBe(true);

    const failingRename = async () => {
      throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
    };

    const first = await recordAdvisoryDecision({
      ...key,
      estimate: PROBE_ESTIMATE,
      telemetryReadings: {},
      reason: "probe",
      renameFn: failingRename
    });

    // The failed attach never fabricates a completed-looking record -- outcome stays null...
    expect(first.outcome).toBeNull();
    const afterFailedAttach = JSON.parse(await fs.readFile(advisoryLogPath(runsDir, key), "utf8"));
    expect(afterFailedAttach.outcome).toBeNull();

    // ...but the outcome itself is still recoverable on disk -- never destroyed before it is
    // durably attached.
    const filesAfterFailure = await fs.readdir(runsDir);
    expect(filesAfterFailure.some((f) => f.includes("round4-failed-attach") && f !== path.basename(advisoryLogPath(runsDir, key)))).toBe(true);

    // A later attempt (recording the same decision again, without the failing renameFn) recovers
    // and attaches the exact retained outcome.
    const second = await recordAdvisoryDecision({ ...key, estimate: PROBE_ESTIMATE, telemetryReadings: {}, reason: "probe retry" });
    expect(second.outcome).toEqual({ actualCostUsd: 2, costKind: "exact" });
    const onDisk = JSON.parse(await fs.readFile(advisoryLogPath(runsDir, key), "utf8"));
    expect(onDisk.outcome).toEqual({ actualCostUsd: 2, costKind: "exact" });

    // Fully consumed -- no marker/claim left behind.
    const filesAfterRecovery = await fs.readdir(runsDir);
    expect(filesAfterRecovery.filter((f) => f.includes("round4-failed-attach"))).toEqual([path.basename(advisoryLogPath(runsDir, key))]);
  });

  it("a writeFileFn failure during attach also leaves the outcome recoverable, attached on a later attempt", async () => {
    const key = { runsDir, cardId: "T-0370", executionId: "round4-write-failure", invocationId: "inv-1" };
    await retainOutcomeUntilDecisionRecorded({ ...key, outcome: { actualCostUsd: 5, costKind: "lower_bound" } });

    let calls = 0;
    const flakyWrite = async (...args) => {
      calls += 1;
      // Let the decision record's own creation write through (call 1); only the attach's own
      // write (call 2, inside consumePendingOutcome) fails.
      if (calls > 1) throw Object.assign(new Error("simulated ENOSPC"), { code: "ENOSPC" });
      return fs.writeFile(...args);
    };

    const first = await recordAdvisoryDecision({ ...key, estimate: PROBE_ESTIMATE, telemetryReadings: {}, reason: "probe", writeFileFn: flakyWrite });
    expect(first.outcome).toBeNull();

    const recovered = await recordAdvisoryDecision({ ...key, estimate: PROBE_ESTIMATE, telemetryReadings: {}, reason: "probe retry" });
    expect(recovered.outcome).toEqual({ actualCostUsd: 5, costKind: "lower_bound" });
  });

  it("a simulated crash after ownership is acquired but before the record is written is recovered by a later consumer", async () => {
    const key = { runsDir, cardId: "T-0370", executionId: "round4-crash-after-claim", invocationId: "inv-1" };
    await recordAdvisoryDecision({ ...key, estimate: PROBE_ESTIMATE, telemetryReadings: {}, reason: "published first" });

    // Hand-author the claim file exactly as a crashed `consumePendingOutcome` would leave it --
    // ownership already acquired (the marker renamed away), but the record never written.
    const markerPath = pendingOutcomePath(runsDir, key);
    const claimPath = `${markerPath}.claim`;
    await fs.writeFile(claimPath, JSON.stringify({ ...key, outcome: { actualCostUsd: 3, costKind: "exact" }, recordedAt: new Date().toISOString() }), "utf8");

    const recovered = await recordAdvisoryDecision({ ...key, estimate: PROBE_ESTIMATE, telemetryReadings: {}, reason: "recovery attempt" });

    expect(recovered.outcome).toEqual({ actualCostUsd: 3, costKind: "exact" });
    await expect(fs.readFile(claimPath, "utf8")).rejects.toThrow();
    await expect(fs.readFile(markerPath, "utf8")).rejects.toThrow();
  });

  it("concurrent consumers -- a live claim versus one left behind by a crash -- end with exactly one attached outcome", async () => {
    const key = { runsDir, cardId: "T-0370", executionId: "round4-concurrent", invocationId: "inv-1" };
    await recordAdvisoryDecision({ ...key, estimate: PROBE_ESTIMATE, telemetryReadings: {}, reason: "published first" });

    const markerPath = pendingOutcomePath(runsDir, key);
    const claimPath = `${markerPath}.claim`;
    await fs.writeFile(claimPath, JSON.stringify({ ...key, outcome: { actualCostUsd: 7, costKind: "exact" }, recordedAt: new Date().toISOString() }), "utf8");

    const results = await Promise.all([
      recordAdvisoryDecision({ ...key, estimate: PROBE_ESTIMATE, telemetryReadings: {}, reason: "consumer A" }),
      recordAdvisoryDecision({ ...key, estimate: PROBE_ESTIMATE, telemetryReadings: {}, reason: "consumer B" })
    ]);

    for (const result of results) {
      expect(result.outcome).toEqual({ actualCostUsd: 7, costKind: "exact" });
    }
    const onDisk = JSON.parse(await fs.readFile(advisoryLogPath(runsDir, key), "utf8"));
    expect(onDisk.outcome).toEqual({ actualCostUsd: 7, costKind: "exact" });
    await expect(fs.readFile(claimPath, "utf8")).rejects.toThrow();
  });

  it("an attachment failure is surfaced through the logger, never silently swallowed into a record that looks complete with outcome: null", async () => {
    const key = { runsDir, cardId: "T-0370", executionId: "round4-logged-failure", invocationId: "inv-1" };
    await retainOutcomeUntilDecisionRecorded({ ...key, outcome: { actualCostUsd: 2, costKind: "exact" } });

    const errors = [];
    const logger = { log() {}, error: (...args) => errors.push(args.join(" ")) };

    await recordAdvisoryDecision({
      ...key,
      estimate: PROBE_ESTIMATE,
      telemetryReadings: {},
      reason: "probe",
      renameFn: async () => {
        throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
      },
      logger
    });

    expect(errors.some((message) => message.includes("round4-logged-failure"))).toBe(true);
  });

  it("a stranded claim file is invisible to measureRecordedCoverage -- never mistaken for a scoreable decision", async () => {
    const key = { runsDir, cardId: "T-0370", executionId: "round4-claim-invisible", invocationId: "inv-1" };
    await recordAdvisoryDecision({ ...key, estimate: PROBE_ESTIMATE, telemetryReadings: {}, reason: "published" });
    const markerPath = pendingOutcomePath(runsDir, key);
    await fs.writeFile(`${markerPath}.claim`, JSON.stringify({ ...key, outcome: { actualCostUsd: 1, costKind: "exact" } }), "utf8");

    const coverage = await measureRecordedCoverage({ runsDir });
    expect(coverage.pending).toBe(1); // the decision record itself, outcome still null
    expect(coverage.unreadable).toBe(0);
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
    if (predictionValue === Infinity) {
      // JSON.stringify(Infinity) serializes to `null`, which would collapse this case into the
      // null-prediction (excludedIndeterminate) path instead of testing the JSON `1e400` case
      // Codex's probe reproduces -- write the raw JSON literal instead, as the probe does.
      const raw = JSON.stringify({ ...existing, prediction: { ...existing.prediction, value: 1 }, outcome }).replace('"value":1', '"value":1e400');
      await fs.writeFile(filePath, raw, "utf8");
      return;
    }
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
