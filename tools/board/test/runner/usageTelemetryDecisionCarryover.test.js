import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { READING_STATUS, revalidateReadingAt, revalidateTelemetryReadingsAt, DEFAULT_MAX_STALENESS_MS } from "../../src/runner/usageTelemetry.js";
import { HOLD_REASON } from "../../src/runner/admissionDecision.js";
import { LAUNCH_TRIGGERS, CardLaunchError } from "../../src/runner/cardLaunch.js";
import { rmTemp } from "../helpers/rmTemp.js";

/**
 * T-0438 fix round 4 (reviewer, 2026-10-16T17:12:25.400Z): "the fresh reading never reaches the
 * launch decision." `autoLaunchPoller.js`'s `tick()` reads telemetry WITH the decision-time probe
 * (`usageProbeFn`) for its own `usage gate comparison` log line, but that value never left the
 * local `telemetryReadings` variable -- the real launch call (`launchFn` -> `launchCardRun` ->
 * `buildLaunchDecide` -> `decideLaunchAdvisory`) re-read telemetry from scratch with NO probe,
 * so the admission formula `evaluateAdmission` consults (the thing that actually matters once
 * `WIP_GATE_ENFORCEMENT_ENABLED` is flipped) still saw the old, scan-only `stale`/`unavailable`
 * data. This file covers both halves of the fix:
 *
 *   1. `revalidateReadingAt`/`revalidateTelemetryReadingsAt` (usageTelemetry.js) -- the reading
 *      the poller already obtained is carried forward, but re-validated for age/reset AT THE
 *      POINT OF CONSUMPTION (the reviewer's explicit instruction), not trusted blindly just
 *      because it was fresh when the poller first read it.
 *   2. An end-to-end test that drives the REAL poller -> REAL `launchCardRun` ->
 *      REAL `buildLaunchDecide`/`decideLaunchAdvisory` chain (only the OS-level
 *      `node:child_process.spawn` call is mocked, exactly like usageProbeDefaultWiring.test.js --
 *      `launchFn` itself is never replaced) and asserts the five-hour reading inside the actual
 *      admission record `evaluateAdmission` produced, not just the poller's own comparison log.
 */

const NOW_MS = 1_788_000_000_000;

function measuredReading(overrides = {}) {
  return {
    windowKind: "five_hour",
    classification: READING_STATUS.MEASURED,
    utilization: 0.37,
    status: "allowed_warning",
    surpassedThreshold: null,
    rateLimitType: "five_hour",
    resetsAtMs: NOW_MS + 3_600_000,
    resetsAtIso: new Date(NOW_MS + 3_600_000).toISOString(),
    resetElapsed: false,
    observedAtMs: NOW_MS,
    ageMs: 0,
    maxStalenessMs: DEFAULT_MAX_STALENESS_MS.five_hour,
    logPath: "probe",
    foundVia: "probe",
    timingTrusted: true,
    reason: "status=allowed_warning rateLimitType=five_hour (probe)",
    ...overrides
  };
}

describe("revalidateReadingAt -- re-checks age/reset at the point of consumption, not just the point of reading (T-0438 fix round 4)", () => {
  it("a reading still within bound at consumption time is carried forward unchanged, with ageMs refreshed", () => {
    const reading = measuredReading();
    const consumedAtMs = NOW_MS + 60_000;

    const result = revalidateReadingAt({ reading, now: consumedAtMs });

    expect(result.classification).toBe(READING_STATUS.MEASURED);
    expect(result.utilization).toBe(0.37);
    expect(result.ageMs).toBe(60_000);
  });

  it("a reading that has aged past its own bound BY THE TIME it is consumed downgrades to stale, utilization withheld", () => {
    const reading = measuredReading();
    const consumedAtMs = NOW_MS + DEFAULT_MAX_STALENESS_MS.five_hour + 60_000;

    const result = revalidateReadingAt({ reading, now: consumedAtMs });

    expect(result.classification).toBe(READING_STATUS.STALE);
    expect(result.utilization).toBeNull();
    expect(result.ageMs).toBe(DEFAULT_MAX_STALENESS_MS.five_hour + 60_000);
  });

  it("a window that has reset since the reading was taken is never carried forward as current -- downgrades to unavailable", () => {
    const reading = measuredReading({ resetsAtMs: NOW_MS + 30_000, resetsAtIso: new Date(NOW_MS + 30_000).toISOString() });
    const consumedAtMs = NOW_MS + 45_000; // past the reset, well inside the staleness bound otherwise

    const result = revalidateReadingAt({ reading, now: consumedAtMs });

    expect(result.classification).toBe(READING_STATUS.UNAVAILABLE);
    expect(result.utilization).toBeNull();
    expect(result.reason).toMatch(/reset/i);
  });

  it("a reading already flagged resetElapsed at scan time is left alone -- that reset was already accounted for", () => {
    const reading = measuredReading({ classification: READING_STATUS.ESTIMATED, utilization: 0, resetElapsed: true, resetsAtMs: NOW_MS - 1000 });

    const result = revalidateReadingAt({ reading, now: NOW_MS + 60_000 });

    expect(result.classification).toBe(READING_STATUS.ESTIMATED);
    expect(result.utilization).toBe(0);
  });

  it("an unavailable reading passes through unchanged -- nothing to revalidate", () => {
    const reading = {
      windowKind: "seven_day",
      classification: READING_STATUS.UNAVAILABLE,
      utilization: null,
      resetsAtMs: null,
      observedAtMs: null,
      maxStalenessMs: DEFAULT_MAX_STALENESS_MS.seven_day,
      reason: "no seven_day telemetry found"
    };

    const result = revalidateReadingAt({ reading, now: NOW_MS + 1_000_000 });

    expect(result).toBe(reading);
  });

  it("a reading with no trustworthy observation instant is left alone -- nothing new to check it against", () => {
    const reading = measuredReading({ classification: READING_STATUS.STALE, utilization: null, observedAtMs: null, timingTrusted: false });

    const result = revalidateReadingAt({ reading, now: NOW_MS + 1_000_000 });

    expect(result).toBe(reading);
  });

  it("never upgrades a reading's freshness -- an already-stale reading stays stale regardless of consumption time", () => {
    const reading = measuredReading({ classification: READING_STATUS.STALE, utilization: null });

    const result = revalidateReadingAt({ reading, now: NOW_MS + 1000 });

    expect(result.classification).toBe(READING_STATUS.STALE);
    expect(result.utilization).toBeNull();
  });
});

describe("revalidateTelemetryReadingsAt -- applies the same check to every window independently", () => {
  it("revalidates five_hour and seven_day each against their own observedAtMs/maxStalenessMs", () => {
    const readings = {
      five_hour: measuredReading(),
      seven_day: {
        windowKind: "seven_day",
        classification: READING_STATUS.UNAVAILABLE,
        utilization: null,
        resetsAtMs: null,
        observedAtMs: null,
        maxStalenessMs: DEFAULT_MAX_STALENESS_MS.seven_day,
        reason: "no seven_day telemetry found"
      }
    };

    const result = revalidateTelemetryReadingsAt({ readings, now: NOW_MS + DEFAULT_MAX_STALENESS_MS.five_hour + 60_000 });

    expect(result.five_hour.classification).toBe(READING_STATUS.STALE);
    expect(result.seven_day.classification).toBe(READING_STATUS.UNAVAILABLE);
  });
});

function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  child.kill = vi.fn();
  return child;
}

function rateLimitEventLine(overrides = {}) {
  return (
    JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        resetsAt: 9_999_999_999,
        utilization: 0.37,
        isUsingOverage: false,
        ...overrides
      },
      uuid: "54d022f9-8efd-43e7-a49f-67cac9a3e682",
      session_id: "18d5c168-5e17-4062-8f5a-4d502597766f"
    }) + "\n"
  );
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});

const { spawn } = await import("node:child_process");
const { createAutoLaunchPoller } = await import("../../src/runner/autoLaunchPoller.js");
const { launchCardRun } = await import("../../src/runner/cardLaunch.js");

function makeTask(overrides = {}) {
  return {
    id: "T-0001",
    title: "A card",
    status: "ready",
    priority: "P1",
    phase: "P1",
    agent: "infra",
    depends_on: [],
    created: "2026-08-29",
    body: "",
    ...overrides
  };
}

function makeStore(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return {
    byId,
    get: vi.fn(async (id) => byId.get(id) ?? null),
    list: vi.fn(async () => [...byId.values()]),
    update: vi.fn(async (id, patch) => {
      const merged = { ...byId.get(id), ...patch };
      byId.set(id, merged);
      return merged;
    })
  };
}

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("the probed five_hour reading reaches the real admission decision, not just the poller's own comparison log (T-0438 fix round 4)", () => {
  let runsDir;
  let killSpy;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-usage-decision-carryover-"));
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => {});
    spawn.mockReset();
  });

  afterEach(async () => {
    await rmTemp(runsDir);
    killSpy.mockRestore();
  });

  it("carries the poller's own probed reading into launchCardRun's real buildLaunchDecide, instead of a second, probe-less scan that finds nothing", async () => {
    const child = fakeChild();
    spawn.mockImplementation(() => child);

    const task = makeTask();
    const store = makeStore([task]);
    const orchestrator = { store, hasActiveRuns: vi.fn(() => false), isRunning: vi.fn(() => false), runsDir, runCard: vi.fn(async () => undefined), hub: { broadcast: vi.fn() } };
    const logger = makeLogger();

    // The REAL launchCardRun -- never replaced -- with enforcement forced on for this test only,
    // so a capacity-fit hold's `err.admission` surfaces the window's own admission decision for
    // inspection. (Enforcement itself is never turned on in production by this card; see
    // docs/usage-telemetry.md's "Do not" list -- this override exists purely so the test can see
    // the one piece of internal state `withAdvisoryLogging` never returns to any caller.)
    //
    // `tick()`'s own queue behaviour (T-0379) catches a `capacityFitHold` refusal and tries the
    // next eligible candidate rather than rethrowing it -- there is none left here, so `tick()`
    // itself resolves normally to a "no card fit" skip. The thing under test is what
    // `launchCardRun` computed on the way there, so `launchFn` captures that directly rather than
    // relying on `tick()`'s own promise to reject.
    let caught = null;
    const launchFn = async (args) => {
      try {
        return await launchCardRun({ ...args, enforcementEnabledFn: () => true });
      } catch (err) {
        caught = err;
        throw err;
      }
    };

    const poller = createAutoLaunchPoller({
      store,
      orchestrator,
      runsDir,
      enabled: true,
      intervalMs: 1_800_000,
      usageMax: 0.8,
      readUsage: vi.fn(async () => ({ utilization: null, status: null, logPath: null, telemetryAbsent: true, reason: "no rate-limit telemetry" })),
      launchFn,
      logger
      // `now` deliberately left at its real-clock default, same as `decideLaunchAdvisory`'s own
      // (never-injected-in-production) `now = Date.now()` -- this test cares about the age GAP
      // between the poller's probe read and the admission read staying small (same tick, real
      // wall-clock milliseconds apart), not about pinning a specific instant. `usageProbeFn` is
      // also deliberately omitted -- the branch head's own default.
    });

    const tickPromise = poller.tick();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.stdout.emit("data", Buffer.from(rateLimitEventLine()));
    await tickPromise;

    expect(caught).toBeInstanceOf(CardLaunchError);
    expect(caught.capacityFitHold).toBe(true);
    expect(caught.admission).toBeTruthy();

    const fiveHourDecision = caught.admission.windows.five_hour;
    // The bug: with the reading lost between the poller's probe and the admission read, this
    // window holds NO_MEASURED_READING -- the admission formula never even saw a number. The fix:
    // the SAME probed reading (utilization 0.37) reaches `evaluateAdmission`, so the window clears
    // the "is there a reading at all" gate and holds for a DIFFERENT, already-known, out-of-scope
    // reason instead (no USD-to-utilization conversion has shipped yet -- T-0402; the per-window
    // formula itself is out of scope for this card -- see admissionDecision.js's own
    // `holdDecision`, which never threads `observedRemainingCapacity` through a
    // units-not-comparable hold, so that field is not a usable signal here either way).
    expect(fiveHourDecision.holdReason).not.toBe(HOLD_REASON.NO_MEASURED_READING);
    expect(fiveHourDecision.holdReason).toBe(HOLD_REASON.UNITS_NOT_COMPARABLE);
    // The raw per-window reading `evaluateAdmission` was actually handed -- this is the direct
    // proof the probe's own number (not a placeholder) reached the admission read.
    expect(caught.telemetryReadings.five_hour.classification).toBe(READING_STATUS.MEASURED);
    expect(caught.telemetryReadings.five_hour.utilization).toBe(0.37);

    // Confirms the trigger this launch went through is still the auto-launch poller's own, not a
    // manual override silently taking over the assertion above.
    expect(spawn).toHaveBeenCalledTimes(1);
    const [, probeArgs] = spawn.mock.calls[0];
    expect(probeArgs).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
  });

  it("omitting the hint (a manual/Run-button launch, which never threads one through) reproduces the exact pre-fix scan-only behavior", async () => {
    const task = makeTask();
    const store = makeStore([task]);
    const orchestrator = { store, isRunning: vi.fn(() => false), runsDir, runCard: vi.fn(async () => undefined), hub: { broadcast: vi.fn() } };

    let caught = null;
    try {
      await launchCardRun({ orchestrator, id: "T-0001", trigger: LAUNCH_TRIGGERS.MANUAL, enforcementEnabledFn: () => true });
    } catch (err) {
      caught = err;
    }

    // A manual launch bypasses the capacity-fit hold itself (T-0379), but the admission decision
    // computed along the way is unaffected by this card either way -- no hint means no behavior
    // change for the path this card does not touch.
    expect(spawn).not.toHaveBeenCalled();
    expect(caught).toBeNull();
    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0001");
  });
});
