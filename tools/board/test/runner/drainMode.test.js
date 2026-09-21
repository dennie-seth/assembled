import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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
  createDrainWaitTracker,
  persistDrainFirstHeld,
  clearPersistedDrainFirstHeld,
  loadPersistedDrainWaitState,
  persistDrainHeldState,
  clearPersistedDrainHeldState,
  loadPersistedDrainHeldState,
  createDrainWaitStateCoordinator
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

  // FIX ROUND 1 finding (a): "maxWaitMs caps only the reported timestamp... still returns
  // waiting with overdue: true and nothing acts on it." Chat's exact reproduction: first hold
  // 1000ms, maxWaitMs 1000ms, now 10000ms -- before this fix that returned WAITING, deadline
  // 2000ms, overdue: true. It must instead transition to a distinct terminal state.
  it("REGRESSION (FIX ROUND 1a): transitions to HELD_WAIT_EXPIRED, not WAITING, once now has passed firstHeldAtMs + maxWaitMs (Chat's repro)", () => {
    const config = { ...DEFAULT_DRAIN_CONFIG, maxWaitMs: 1000 };
    const a = admission({ five_hour: { admitted: false }, seven_day: { admitted: true } });
    const waitState = { firstHeldAtMs: 1000 };
    const result = evaluateDrainState({ admission: a, telemetryReadings: {}, waitState, now: 10000, config });

    expect(result.status).toBe(DRAIN_STATUS.HELD_WAIT_EXPIRED);
    expect(result.status).not.toBe(DRAIN_STATUS.WAITING);
    expect(result.blockingWindow).toBe("five_hour");
    expect(result.reason).toMatch(/five_hour/);
    expect(result.reason).toMatch(/human|intervention/i);
  });

  it("stays WAITING right up to (but not past) the bound", () => {
    const config = { ...DEFAULT_DRAIN_CONFIG, maxWaitMs: 1000 };
    const a = admission({ five_hour: { admitted: false }, seven_day: { admitted: true } });
    const waitState = { firstHeldAtMs: 1000 };
    const result = evaluateDrainState({ admission: a, telemetryReadings: {}, waitState, now: 1999, config });
    expect(result.status).toBe(DRAIN_STATUS.WAITING);
  });

  it("never lets a fresh hold (no prior waitState) start out already expired -- the bound is measured from firstHeldAtMs, not from an assumed history", () => {
    const config = { ...DEFAULT_DRAIN_CONFIG, maxWaitMs: 60 * 60 * 1000 };
    const a = admission({ five_hour: { admitted: false }, seven_day: { admitted: true } });
    const result = evaluateDrainState({ admission: a, telemetryReadings: {}, waitState: null, now: 10_000_000, config });
    expect(result.status).toBe(DRAIN_STATUS.WAITING);
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

  // FIX ROUND 1 finding (a): "the tracker forgets the original deadline across a board restart" --
  // a freshly-constructed tracker can be SEEDED with previously-persisted firstHeldAtMs values, so
  // the process that creates it (boardServer.js, after loadPersistedDrainWaitState) can restore
  // exactly what a restart would otherwise silently reset.
  it("accepts a seed of previously-persisted firstHeldAtMs values, preserving the ORIGINAL deadline rather than starting a fresh one", () => {
    const tracker = createDrainWaitTracker({ seed: { "T-0001": 1000 } });
    expect(tracker.get("T-0001")).toMatchObject({ firstHeldAtMs: 1000 });
  });

  it("a seeded card's own recordHeld still keeps the seeded firstHeldAtMs fixed, only bumping timesPassedOver", () => {
    const tracker = createDrainWaitTracker({ seed: { "T-0001": 1000 } });
    const state = tracker.recordHeld("T-0001", 50_000);
    expect(state.firstHeldAtMs).toBe(1000);
  });
});

/**
 * FIX ROUND 1 finding (a): "the tracker also forgets the original deadline across a board
 * restart, so a restart quietly extends the bound." These three functions are the persistence
 * side of that: `persistDrainFirstHeld` writes ONLY the first-hold timestamp (never the whole
 * wait-state object -- timesPassedOver/lastDrainState are this process's own bookkeeping, not
 * durable facts), `loadPersistedDrainWaitState` reads every persisted timestamp back at startup,
 * and `clearPersistedDrainFirstHeld` removes one once a card leaves drain. Same durability class
 * and atomic-write posture as launchReservation.js's own sidecar files, deliberately scoped to
 * `runsDir` so it lives alongside every other piece of runner-owned, non-store state.
 */
describe("persistDrainFirstHeld / loadPersistedDrainWaitState / clearPersistedDrainFirstHeld -- surviving a board restart", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-drainmode-"));
  });

  afterEach(async () => {
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  it("round-trips a single card's firstHeldAtMs through a fresh load -- simulating a board restart", async () => {
    await persistDrainFirstHeld({ runsDir, cardId: "T-0001", firstHeldAtMs: 1000 });

    const loaded = await loadPersistedDrainWaitState({ runsDir });
    expect(loaded).toEqual({ "T-0001": 1000 });
  });

  // The literal FIX ROUND 1 requirement: "A test restarts the tracker mid-wait and asserts the
  // deadline is unchanged."
  it("REGRESSION (FIX ROUND 1a): a tracker seeded from a restart reports the SAME deadline as before the restart, not a freshly-started one", async () => {
    const firstHeldAtMs = 1000;
    await persistDrainFirstHeld({ runsDir, cardId: "T-0001", firstHeldAtMs });
    const config = { ...DEFAULT_DRAIN_CONFIG, maxWaitMs: 60 * 60 * 1000 };
    const originalDeadline = firstHeldAtMs + config.maxWaitMs;

    // "Restart": a brand-new process, a brand-new tracker, seeded only from what's on disk --
    // never from the dead process's in-memory Map.
    const seed = await loadPersistedDrainWaitState({ runsDir });
    const restartedTracker = createDrainWaitTracker({ seed });

    const muchLaterNow = firstHeldAtMs + 10 * config.maxWaitMs;
    const result = computeNextReconsideration({
      blockingWindow: "five_hour",
      telemetryReadings: {},
      waitState: restartedTracker.get("T-0001"),
      now: muchLaterNow,
      config
    });
    expect(restartedTracker.get("T-0001").firstHeldAtMs).toBe(firstHeldAtMs);
    expect(result.nextReconsiderationAtMs).toBe(originalDeadline);
  });

  it("loads multiple persisted cards into one seed object", async () => {
    await persistDrainFirstHeld({ runsDir, cardId: "T-0001", firstHeldAtMs: 1000 });
    await persistDrainFirstHeld({ runsDir, cardId: "T-0002", firstHeldAtMs: 2000 });

    const loaded = await loadPersistedDrainWaitState({ runsDir });
    expect(loaded).toEqual({ "T-0001": 1000, "T-0002": 2000 });
  });

  it("returns {} when nothing has ever been persisted (a fresh runsDir, or drain mode never engaged before)", async () => {
    const loaded = await loadPersistedDrainWaitState({ runsDir });
    expect(loaded).toEqual({});
  });

  it("returns {} when runsDir itself doesn't exist yet -- never throws", async () => {
    const loaded = await loadPersistedDrainWaitState({ runsDir: path.join(runsDir, "does-not-exist") });
    expect(loaded).toEqual({});
  });

  it("clearPersistedDrainFirstHeld removes a card's sidecar so a future load no longer sees it", async () => {
    await persistDrainFirstHeld({ runsDir, cardId: "T-0001", firstHeldAtMs: 1000 });
    await clearPersistedDrainFirstHeld({ runsDir, cardId: "T-0001" });

    const loaded = await loadPersistedDrainWaitState({ runsDir });
    expect(loaded).toEqual({});
  });

  it("clearPersistedDrainFirstHeld is a no-op, not a throw, for a card that was never persisted", async () => {
    await expect(clearPersistedDrainFirstHeld({ runsDir, cardId: "T-9999" })).resolves.not.toThrow();
  });

  it("persistDrainFirstHeld is a no-op when runsDir is not provided -- drain persistence is opt-in, matching drain mode's own off-by-default posture", async () => {
    await expect(persistDrainFirstHeld({ runsDir: null, cardId: "T-0001", firstHeldAtMs: 1000 })).resolves.not.toThrow();
  });

  it("loadPersistedDrainWaitState returns {} when runsDir is not provided", async () => {
    expect(await loadPersistedDrainWaitState({ runsDir: null })).toEqual({});
  });
});

/**
 * FIX ROUND 2 finding 1 (Chat round-3 review of #408): "persistence and cleanup are coordinated
 * so a cleared file cannot be recreated by an outstanding first-hold write that was already in
 * flight." `persistDrainFirstHeld`/`clearPersistedDrainFirstHeld` above are each independently
 * fire-and-forget from autoLaunchPoller.js -- nothing stops a slow persist write from completing
 * AFTER a clear that was issued later, recreating a deadline for a wait that already finished.
 * `createDrainWaitStateCoordinator` gives every card its own promise chain so persist/clear run in
 * ISSUE order, not completion order: a clear queued after a persist always executes -- and wins --
 * only once that persist's own write has settled.
 */
describe("createDrainWaitStateCoordinator -- ordered persist/clear per card (FIX ROUND 2 finding 1)", () => {
  function deferred() {
    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it("REGRESSION (FIX ROUND 2, finding 1): a clear issued while a first-hold persist is still in flight always wins -- the write lands, then the clear removes it, never the other order", async () => {
    const order = [];
    const write = deferred();
    const writeFileFn = vi.fn(async () => {
      order.push("write:start");
      await write.promise;
      order.push("write:done");
    });
    const mkdirFn = vi.fn(async () => {});
    const unlinkFn = vi.fn(async () => {
      order.push("unlink");
    });

    const coordinator = createDrainWaitStateCoordinator({ runsDir: "/fake-runs", writeFileFn, mkdirFn, unlinkFn });

    const persistPromise = coordinator.persistFirstHeld("T-0001", 1000);
    const clearPromise = coordinator.clearFirstHeld("T-0001");

    // The clear must not run ahead of the still-pending write.
    expect(unlinkFn).not.toHaveBeenCalled();

    write.resolve();
    await persistPromise;
    await clearPromise;

    expect(order).toEqual(["write:start", "write:done", "unlink"]);
    expect(writeFileFn).toHaveBeenCalledTimes(1);
    expect(unlinkFn).toHaveBeenCalledTimes(1);
  });

  it("keeps separate cards' chains independent -- a slow write for one card never blocks a clear for another", async () => {
    const order = [];
    const writeFileFn = vi.fn(async (filePath) => {
      if (filePath.includes("T-0001")) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      order.push(`write:${filePath.includes("T-0001") ? "T-0001" : "T-0002"}`);
    });
    const mkdirFn = vi.fn(async () => {});
    const unlinkFn = vi.fn(async (filePath) => {
      order.push(`unlink:${filePath.includes("T-0002") ? "T-0002" : "T-0001"}`);
    });
    const coordinator = createDrainWaitStateCoordinator({ runsDir: "/fake-runs", writeFileFn, mkdirFn, unlinkFn });

    const slowPersist = coordinator.persistFirstHeld("T-0001", 1000);
    const fastClear = coordinator.clearFirstHeld("T-0002");

    await fastClear;
    expect(order).toContain("unlink:T-0002");
    expect(order).not.toContain("write:T-0001");

    await slowPersist;
    expect(order).toContain("write:T-0001");
  });

  it("flush() waits for every in-flight persist/clear across every card to settle", async () => {
    const write = deferred();
    const writeFileFn = vi.fn(async () => {
      await write.promise;
    });
    const mkdirFn = vi.fn(async () => {});
    const unlinkFn = vi.fn(async () => {});
    const coordinator = createDrainWaitStateCoordinator({ runsDir: "/fake-runs", writeFileFn, mkdirFn, unlinkFn });

    coordinator.persistFirstHeld("T-0001", 1000);
    let flushed = false;
    const flushPromise = coordinator.flush().then(() => {
      flushed = true;
    });

    await Promise.resolve();
    expect(flushed).toBe(false);

    write.resolve();
    await flushPromise;
    expect(flushed).toBe(true);
  });

  it("a failed persist does not break the chain -- a subsequent clear for the same card still runs", async () => {
    const writeFileFn = vi.fn(async () => {
      throw new Error("disk full");
    });
    const mkdirFn = vi.fn(async () => {});
    const unlinkFn = vi.fn(async () => {});
    const coordinator = createDrainWaitStateCoordinator({ runsDir: "/fake-runs", writeFileFn, mkdirFn, unlinkFn });

    await coordinator.persistFirstHeld("T-0001", 1000).catch(() => {});
    await coordinator.clearFirstHeld("T-0001");

    expect(unlinkFn).toHaveBeenCalledTimes(1);
  });
});

/**
 * FIX ROUND 3 (Chat 2026-09-21 review of #408, finding 1): "terminal holds are in-memory only, so
 * a restart erases them... after a restart neither the seeded drainTracker nor the fresh terminal
 * map knows the card -- and because the card is blocked it is not an eligible candidate, so no
 * later tick ever recreates the entry." These three functions are the durable side of a terminal
 * hold (HELD_WAIT_EXPIRED / HELD_OVERSIZED) -- kept as their OWN sidecar, deliberately separate
 * from persistDrainFirstHeld's deadline file, since the two states are mutually exclusive for a
 * card and conflating the files would make it impossible to tell, from disk alone, which state a
 * restart should restore.
 */
describe("persistDrainHeldState / loadPersistedDrainHeldState / clearPersistedDrainHeldState -- terminal holds surviving a board restart (FIX ROUND 3)", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-drainmode-held-"));
  });

  afterEach(async () => {
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  const heldState = Object.freeze({
    status: DRAIN_STATUS.HELD_WAIT_EXPIRED,
    blockingWindow: "five_hour",
    reason: "Drain wait bound reached for the five_hour window",
    nextReconsiderationAtMs: null,
    agingBoost: 3
  });

  it("round-trips a single card's terminal hold through a fresh load -- simulating a board restart", async () => {
    await persistDrainHeldState({ runsDir, cardId: "T-0001", heldState });

    const loaded = await loadPersistedDrainHeldState({ runsDir });
    expect(loaded).toEqual({ "T-0001": heldState });
  });

  it("loads multiple persisted cards into one map", async () => {
    const oversized = { ...heldState, status: DRAIN_STATUS.HELD_OVERSIZED, blockingWindow: "seven_day" };
    await persistDrainHeldState({ runsDir, cardId: "T-0001", heldState });
    await persistDrainHeldState({ runsDir, cardId: "T-0002", heldState: oversized });

    const loaded = await loadPersistedDrainHeldState({ runsDir });
    expect(loaded).toEqual({ "T-0001": heldState, "T-0002": oversized });
  });

  it("returns {} when nothing has ever been persisted", async () => {
    expect(await loadPersistedDrainHeldState({ runsDir })).toEqual({});
  });

  it("returns {} when runsDir itself doesn't exist yet -- never throws", async () => {
    expect(await loadPersistedDrainHeldState({ runsDir: path.join(runsDir, "does-not-exist") })).toEqual({});
  });

  it("clearPersistedDrainHeldState removes a card's sidecar so a future load no longer sees it -- resolution, not a timeout", async () => {
    await persistDrainHeldState({ runsDir, cardId: "T-0001", heldState });
    await clearPersistedDrainHeldState({ runsDir, cardId: "T-0001" });

    expect(await loadPersistedDrainHeldState({ runsDir })).toEqual({});
  });

  it("clearPersistedDrainHeldState is a no-op, not a throw, for a card that was never persisted", async () => {
    await expect(clearPersistedDrainHeldState({ runsDir, cardId: "T-9999" })).resolves.not.toThrow();
  });

  it("persistDrainHeldState is a no-op when runsDir is not provided", async () => {
    await expect(persistDrainHeldState({ runsDir: null, cardId: "T-0001", heldState })).resolves.not.toThrow();
  });

  it("loadPersistedDrainHeldState returns {} when runsDir is not provided", async () => {
    expect(await loadPersistedDrainHeldState({ runsDir: null })).toEqual({});
  });
});

/**
 * FIX ROUND 3: the same ordered-persist/clear coordination FIX ROUND 2 gave the deadline sidecar
 * (createDrainWaitStateCoordinator -- ordered persist/clear per card, above) extends to the
 * terminal-hold sidecar too, so an outstanding persist for a just-recovered hold can never
 * outlive a clear issued after it (e.g. a human resolving the hold moments after a restart
 * reconciles it).
 */
describe("createDrainWaitStateCoordinator -- ordered persist/clear for terminal holds (FIX ROUND 3)", () => {
  function deferred() {
    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it("a clear issued while a terminal-hold persist is still in flight always wins -- the write lands, then the clear removes it, never the other order", async () => {
    const order = [];
    const write = deferred();
    const writeFileFn = vi.fn(async () => {
      order.push("write:start");
      await write.promise;
      order.push("write:done");
    });
    const mkdirFn = vi.fn(async () => {});
    const unlinkFn = vi.fn(async () => {
      order.push("unlink");
    });
    const coordinator = createDrainWaitStateCoordinator({ runsDir: "/fake-runs", writeFileFn, mkdirFn, unlinkFn });

    const persistPromise = coordinator.persistHeldState("T-0001", { status: DRAIN_STATUS.HELD_WAIT_EXPIRED });
    const clearPromise = coordinator.clearHeldState("T-0001");

    expect(unlinkFn).not.toHaveBeenCalled();

    write.resolve();
    await persistPromise;
    await clearPromise;

    expect(order).toEqual(["write:start", "write:done", "unlink"]);
  });

  it("flush() also waits for in-flight terminal-hold persist/clear operations", async () => {
    const write = deferred();
    const writeFileFn = vi.fn(async () => {
      await write.promise;
    });
    const mkdirFn = vi.fn(async () => {});
    const unlinkFn = vi.fn(async () => {});
    const coordinator = createDrainWaitStateCoordinator({ runsDir: "/fake-runs", writeFileFn, mkdirFn, unlinkFn });

    coordinator.persistHeldState("T-0001", { status: DRAIN_STATUS.HELD_WAIT_EXPIRED });
    let flushed = false;
    const flushPromise = coordinator.flush().then(() => {
      flushed = true;
    });

    await Promise.resolve();
    expect(flushed).toBe(false);

    write.resolve();
    await flushPromise;
    expect(flushed).toBe(true);
  });
});
