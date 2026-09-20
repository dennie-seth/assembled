import { describe, it, expect, afterEach } from "vitest";
import { HOLD_REASON } from "../../src/runner/admissionDecision.js";
import {
  DRAIN_STATUS,
  DEFAULT_DRAIN_CONFIG,
  drainModeEnabledFromEnv,
  detectOversizedCard,
  selectBlockingWindow,
  computeNextReconsideration,
  computeAgingBoost,
  evaluateDrainState,
  createDrainWaitTracker
} from "../../src/runner/drainMode.js";

/**
 * WIP gate T-F (spec §9): drain mode's own decision logic, tested in isolation from the admission
 * formula (admissionDecision.js) and from the poller (autoLaunchPoller.js) it feeds. Every function
 * here is pure -- no filesystem, no clock reads -- so `now` and every reading/estimate/waitState is
 * always passed in explicitly.
 */

function admission(windows) {
  const decisions = Object.fromEntries(
    Object.entries(windows).map(([windowKind, overrides]) => [
      windowKind,
      { windowKind, admitted: null, holdReason: null, ...overrides }
    ])
  );
  const admitted = Object.values(decisions).every((d) => d.admitted === true)
    ? true
    : Object.values(decisions).some((d) => d.admitted === false)
      ? false
      : null;
  return { admitted, windows: decisions };
}

function reading(overrides = {}) {
  return { classification: "measured", utilization: 0.5, resetElapsed: false, resetsAtMs: null, ...overrides };
}

describe("drainModeEnabledFromEnv", () => {
  afterEach(() => {
    delete process.env.WIP_GATE_DRAIN_MODE_ENABLED;
  });

  it("defaults to OFF when unset -- drain mode never engages on the live board by accident", () => {
    delete process.env.WIP_GATE_DRAIN_MODE_ENABLED;
    expect(drainModeEnabledFromEnv()).toBe(false);
  });

  it.each(["1", "true", "on", "yes", "TRUE", "On"])("accepts %s as enabled", (value) => {
    process.env.WIP_GATE_DRAIN_MODE_ENABLED = value;
    expect(drainModeEnabledFromEnv()).toBe(true);
  });

  it.each(["0", "false", "off", "no", "", "garbage"])("treats %s as disabled", (value) => {
    process.env.WIP_GATE_DRAIN_MODE_ENABLED = value;
    expect(drainModeEnabledFromEnv()).toBe(false);
  });
});

describe("detectOversizedCard -- before draining, a permanent misfit is named, not queued", () => {
  it("returns null when admission is unavailable", () => {
    expect(detectOversizedCard({ admission: null })).toBeNull();
  });

  it("returns null when no window is oversized", () => {
    const a = admission({
      five_hour: { admitted: false, holdReason: HOLD_REASON.NO_MEASURED_READING },
      seven_day: { admitted: true }
    });
    expect(detectOversizedCard({ admission: a })).toBeNull();
  });

  it("names the five_hour window and suggests a split/re-scope when it is the oversized one", () => {
    const a = admission({
      five_hour: { admitted: false, holdReason: HOLD_REASON.OVERSIZED_ESTIMATE_NEVER_FITS },
      seven_day: { admitted: true }
    });
    const result = detectOversizedCard({ admission: a });
    expect(result.windowKind).toBe("five_hour");
    expect(result.reason).toMatch(/five_hour/);
    expect(result.reason).toMatch(/split/i);
    expect(result.reason).toMatch(/re-scope/i);
  });

  it("names the seven_day (weekly) window when IT is the oversized one", () => {
    const a = admission({
      five_hour: { admitted: false, holdReason: HOLD_REASON.NO_MEASURED_READING },
      seven_day: { admitted: false, holdReason: HOLD_REASON.OVERSIZED_ESTIMATE_NEVER_FITS }
    });
    const result = detectOversizedCard({ admission: a });
    expect(result.windowKind).toBe("seven_day");
    expect(result.reason).toMatch(/seven_day/);
  });
});

describe("selectBlockingWindow -- a weekly shortage is never masked by (or reduced to) the 5-hour window", () => {
  it("returns null when nothing is admitted false", () => {
    const a = admission({ five_hour: { admitted: true }, seven_day: { admitted: null, holdReason: HOLD_REASON.ESTIMATE_UNKNOWN } });
    expect(selectBlockingWindow({ admission: a })).toBeNull();
  });

  it("names five_hour when only it is blocked", () => {
    const a = admission({ five_hour: { admitted: false }, seven_day: { admitted: true } });
    expect(selectBlockingWindow({ admission: a })).toBe("five_hour");
  });

  it("names seven_day when only it is blocked, even though five_hour looks healthy", () => {
    const a = admission({ five_hour: { admitted: true }, seven_day: { admitted: false } });
    expect(selectBlockingWindow({ admission: a })).toBe("seven_day");
  });

  it("names seven_day, never five_hour, when BOTH windows are blocked -- only the weekly reset can ever resolve a weekly shortage", () => {
    const a = admission({ five_hour: { admitted: false }, seven_day: { admitted: false } });
    expect(selectBlockingWindow({ admission: a })).toBe("seven_day");
  });
});

describe("computeNextReconsideration -- a weekly shortage is never treated as solvable by waiting for a 5-hour reset", () => {
  const now = Date.parse("2026-09-20T00:00:00.000Z");

  it("uses the BLOCKING window's own reset, not any other window's, even when the other window resets much sooner", () => {
    const fiveHourResetMs = now + 10 * 60 * 1000; // 10 minutes -- soon
    const sevenDayResetMs = now + 3 * 24 * 60 * 60 * 1000; // 3 days -- the true horizon
    const telemetryReadings = {
      five_hour: reading({ resetsAtMs: fiveHourResetMs }),
      seven_day: reading({ resetsAtMs: sevenDayResetMs })
    };

    const result = computeNextReconsideration({ blockingWindow: "seven_day", telemetryReadings, waitState: null, now });
    expect(result.nextReconsiderationAtMs).toBe(sevenDayResetMs);
    expect(result.nextReconsiderationAtMs).not.toBe(fiveHourResetMs);
    expect(result.basis).toBe("window_reset");
  });

  it("falls back to a bounded recheck cadence when the blocking window's own reset is unknown", () => {
    const telemetryReadings = { seven_day: reading({ resetsAtMs: null }) };
    const result = computeNextReconsideration({
      blockingWindow: "seven_day",
      telemetryReadings,
      waitState: null,
      now,
      config: DEFAULT_DRAIN_CONFIG
    });
    expect(result.nextReconsiderationAtMs).toBe(now + DEFAULT_DRAIN_CONFIG.fallbackRecheckMs);
    expect(result.basis).toBe("fallback_recheck");
  });

  it("falls back when the blocking window's reset already elapsed (stale timing, never trusted as a future instant)", () => {
    const telemetryReadings = { seven_day: reading({ resetsAtMs: now - 1000, resetElapsed: true }) };
    const result = computeNextReconsideration({ blockingWindow: "seven_day", telemetryReadings, waitState: null, now });
    expect(result.basis).toBe("fallback_recheck");
  });

  it("bounds the wait: never reports a reconsideration later than firstHeldAtMs + maxWaitMs", () => {
    const config = { ...DEFAULT_DRAIN_CONFIG, maxWaitMs: 60 * 60 * 1000 }; // 1h bound
    const farResetMs = now + 30 * 24 * 60 * 60 * 1000; // 30 days -- far past the bound
    const telemetryReadings = { seven_day: reading({ resetsAtMs: farResetMs }) };
    const waitState = { firstHeldAtMs: now - 30 * 60 * 1000 }; // held for 30 minutes already

    const result = computeNextReconsideration({ blockingWindow: "seven_day", telemetryReadings, waitState, now, config });
    expect(result.nextReconsiderationAtMs).toBe(waitState.firstHeldAtMs + config.maxWaitMs);
    expect(result.basis).toBe("bounded_max_wait");
  });

  it("reports overdue once now has passed the bound", () => {
    const config = { ...DEFAULT_DRAIN_CONFIG, maxWaitMs: 1000 };
    const waitState = { firstHeldAtMs: now - 5000 };
    const result = computeNextReconsideration({ blockingWindow: "five_hour", telemetryReadings: {}, waitState, now, config });
    expect(result.overdue).toBe(true);
  });

  it("treats a never-before-held card (no waitState) as freshly held as of now for the bound", () => {
    const config = { ...DEFAULT_DRAIN_CONFIG, maxWaitMs: 60 * 60 * 1000 };
    const result = computeNextReconsideration({ blockingWindow: "five_hour", telemetryReadings: {}, waitState: null, now, config });
    expect(result.overdue).toBe(false);
  });
});

describe("computeAgingBoost -- waiting cards age so ordinary work is not starved", () => {
  const now = Date.parse("2026-09-20T00:00:00.000Z");
  const config = { ...DEFAULT_DRAIN_CONFIG, agingStepMs: 60 * 60 * 1000 };

  it("is 0 for a card with no wait history", () => {
    expect(computeAgingBoost({ waitState: null, now, config })).toBe(0);
  });

  it("is 0 for a card held less than one full aging step", () => {
    const waitState = { firstHeldAtMs: now - 30 * 60 * 1000 };
    expect(computeAgingBoost({ waitState, now, config })).toBe(0);
  });

  it("increments once per full aging step elapsed", () => {
    const waitState = { firstHeldAtMs: now - 3.5 * config.agingStepMs };
    expect(computeAgingBoost({ waitState, now, config })).toBe(3);
  });
});

describe("evaluateDrainState -- the composed decision", () => {
  const now = Date.parse("2026-09-20T00:00:00.000Z");

  it("is CLEAR when nothing is oversized and no window is confirmed blocked", () => {
    const a = admission({ five_hour: { admitted: null, holdReason: HOLD_REASON.ESTIMATE_UNKNOWN }, seven_day: { admitted: null } });
    const result = evaluateDrainState({ admission: a, telemetryReadings: {}, waitState: null, now });
    expect(result.status).toBe(DRAIN_STATUS.CLEAR);
    expect(result.blockingWindow).toBeNull();
    expect(result.nextReconsiderationAtMs).toBeNull();
  });

  it("is HELD_OVERSIZED and skips waiting/aging entirely when a window is a permanent misfit", () => {
    const a = admission({
      five_hour: { admitted: true },
      seven_day: { admitted: false, holdReason: HOLD_REASON.OVERSIZED_ESTIMATE_NEVER_FITS }
    });
    const waitState = { firstHeldAtMs: now - 10 * 60 * 60 * 1000 };
    const result = evaluateDrainState({ admission: a, telemetryReadings: {}, waitState, now });
    expect(result.status).toBe(DRAIN_STATUS.HELD_OVERSIZED);
    expect(result.blockingWindow).toBe("seven_day");
    expect(result.reason).toMatch(/seven_day/);
    expect(result.nextReconsiderationAtMs).toBeNull();
    expect(result.agingBoost).toBe(0);
  });

  it("is WAITING with the weekly window's own reset when only the weekly window is short, never the 5-hour reset", () => {
    const fiveHourResetMs = now + 5 * 60 * 1000;
    const sevenDayResetMs = now + 2 * 24 * 60 * 60 * 1000;
    const a = admission({ five_hour: { admitted: true }, seven_day: { admitted: false } });
    const telemetryReadings = {
      five_hour: reading({ resetsAtMs: fiveHourResetMs }),
      seven_day: reading({ resetsAtMs: sevenDayResetMs })
    };

    const result = evaluateDrainState({ admission: a, telemetryReadings, waitState: null, now });
    expect(result.status).toBe(DRAIN_STATUS.WAITING);
    expect(result.blockingWindow).toBe("seven_day");
    expect(result.nextReconsiderationAtMs).toBe(sevenDayResetMs);
  });

  it("carries a growing agingBoost through to the composed result for a long-waiting card", () => {
    const config = { ...DEFAULT_DRAIN_CONFIG, agingStepMs: 60 * 60 * 1000 };
    const a = admission({ five_hour: { admitted: false }, seven_day: { admitted: true } });
    const waitState = { firstHeldAtMs: now - 4 * config.agingStepMs };
    const result = evaluateDrainState({ admission: a, telemetryReadings: {}, waitState, now, config });
    expect(result.status).toBe(DRAIN_STATUS.WAITING);
    expect(result.agingBoost).toBe(4);
  });
});

describe("createDrainWaitTracker -- in-memory, per-card wait bookkeeping", () => {
  it("records a fresh entry on first hold, with timesPassedOver 1", () => {
    const tracker = createDrainWaitTracker();
    const state = tracker.recordHeld("T-0001", 1000);
    expect(state).toEqual({ firstHeldAtMs: 1000, timesPassedOver: 1, lastDrainState: null });
    expect(tracker.get("T-0001")).toEqual(state);
  });

  it("keeps firstHeldAtMs fixed and increments timesPassedOver on repeated holds", () => {
    const tracker = createDrainWaitTracker();
    tracker.recordHeld("T-0001", 1000);
    const second = tracker.recordHeld("T-0001", 5000);
    expect(second.firstHeldAtMs).toBe(1000);
    expect(second.timesPassedOver).toBe(2);
  });

  it("stores the latest drain state alongside the wait bookkeeping", () => {
    const tracker = createDrainWaitTracker();
    tracker.recordHeld("T-0001", 1000, { status: DRAIN_STATUS.WAITING, blockingWindow: "seven_day" });
    expect(tracker.get("T-0001").lastDrainState).toEqual({ status: DRAIN_STATUS.WAITING, blockingWindow: "seven_day" });
  });

  it("returns null for a card never held", () => {
    const tracker = createDrainWaitTracker();
    expect(tracker.get("T-9999")).toBeNull();
  });

  it("clears a card's wait state entirely", () => {
    const tracker = createDrainWaitTracker();
    tracker.recordHeld("T-0001", 1000);
    tracker.clear("T-0001");
    expect(tracker.get("T-0001")).toBeNull();
  });

  it("snapshots every currently-tracked card, merging its last drain state in", () => {
    const tracker = createDrainWaitTracker();
    tracker.recordHeld("T-0001", 1000, { status: DRAIN_STATUS.WAITING, blockingWindow: "five_hour", nextReconsiderationAtMs: 9000 });
    tracker.recordHeld("T-0002", 2000);
    const snapshot = tracker.snapshot();
    expect(snapshot["T-0001"]).toMatchObject({
      firstHeldAtMs: 1000,
      timesPassedOver: 1,
      status: DRAIN_STATUS.WAITING,
      blockingWindow: "five_hour",
      nextReconsiderationAtMs: 9000
    });
    expect(snapshot["T-0002"]).toMatchObject({ firstHeldAtMs: 2000, timesPassedOver: 1 });
    expect(Object.keys(snapshot).sort()).toEqual(["T-0001", "T-0002"]);
  });

  it("snapshot is empty for a tracker that has never recorded anything -- default config, nothing to show", () => {
    const tracker = createDrainWaitTracker();
    expect(tracker.snapshot()).toEqual({});
  });
});
