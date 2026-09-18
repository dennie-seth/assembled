import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAutoLaunchPoller } from "../../src/runner/autoLaunchPoller.js";
import { launchCardRun, LAUNCH_TRIGGERS } from "../../src/runner/cardLaunch.js";
import { buildLaunchDecide as realBuildLaunchDecide } from "../../src/runner/launchAdvisory.js";
import { evaluateAdmission as realEvaluateAdmission } from "../../src/runner/admissionDecision.js";
import { listActiveReservations } from "../../src/runner/launchReservation.js";

/**
 * T-0379 acceptance: "Tests, through the real poller tick and the real launchCardRun (not
 * hand-composed primitives)". Everything below wires the REAL `createAutoLaunchPoller` to the REAL
 * `launchCardRun` to the REAL `buildLaunchDecide`/`evaluateAdmission` -- the only things stubbed
 * are the telemetry reading (so a test can pick a utilization deterministically) and the unit
 * conversion (so "fits"/"doesn't fit" is provable without this card shipping a real derived rate --
 * see docs/wip-gate-admission.md's "Units" note: no conversion ships, so admission tests need one
 * injected to exercise the fit/no-fit branches at all).
 */

const UNIT_CONVERSION = { usdPerUtilizationUnit: 10, sampleCount: 20, fitDate: "2026-09-01", version: "v1" };

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

function makeOrchestrator(tasks, { runsDir, runCard } = {}) {
  const store = makeStore(tasks);
  return {
    store,
    runsDir,
    hub: { broadcast: vi.fn() },
    isRunning: vi.fn(() => false),
    hasActiveRuns: vi.fn(() => false),
    activeCardIds: new Set(),
    runCard: runCard ?? vi.fn(async () => undefined)
  };
}

/** A `readUsageTelemetry`-shaped stub, controllable per test. */
function telemetry({
  fiveHourUtilization = 0.1,
  sevenDayUtilization = 0.1,
  fiveHourClassification = "measured",
  sevenDayClassification = "measured"
} = {}) {
  return async () => ({
    five_hour: {
      windowKind: "five_hour",
      classification: fiveHourClassification,
      utilization: fiveHourClassification === "measured" ? fiveHourUtilization : null,
      resetElapsed: false
    },
    seven_day: {
      windowKind: "seven_day",
      classification: sevenDayClassification,
      utilization: sevenDayClassification === "measured" ? sevenDayUtilization : null,
      resetElapsed: false
    }
  });
}

/** The real launchCardRun, through the real buildLaunchDecide, with enforcement on and a fixed unit conversion injected so fit/no-fit is provable without this card shipping a real derived rate. */
function makeLaunchFn({ readUsageTelemetryFn }) {
  return ({ orchestrator, id, trigger, logger }) =>
    launchCardRun({
      orchestrator,
      id,
      trigger,
      logger,
      enforcementEnabledFn: () => true,
      buildLaunchDecideFn: (args) =>
        realBuildLaunchDecide({
          ...args,
          readUsageTelemetryFn,
          evaluateAdmissionFn: (evalArgs) => realEvaluateAdmission({ ...evalArgs, unitConversion: UNIT_CONVERSION })
        })
    });
}

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A test's fire-and-forget reconciliation (runCardPromise.then(...) inside launchCardRun) can still be mid-write when the test itself returns -- retry across that real-fs race rather than letting a stray ENOTEMPTY fail an unrelated test. */
async function rmRetrying(dir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err.code !== "ENOTEMPTY" || attempt === 9) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

let runsDir;

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "wip-gate-integration-test-"));
});

afterEach(async () => {
  await rmRetrying(runsDir);
});

describe("T-0379 integration: the real poller tick, through the real launchCardRun", () => {
  it("auto-admits a card that fits the 5-hour window", async () => {
    const orchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "infra" })], { runsDir });
    const logger = makeLogger();
    const poller = createAutoLaunchPoller({
      store: orchestrator.store,
      orchestrator,
      runsDir,
      enabled: true,
      intervalMs: 1000,
      usageMax: 0.8,
      readUsage: async () => ({ utilization: 0, status: "allowed", reason: "status=allowed" }),
      readUsageTelemetryFn: telemetry({ fiveHourUtilization: 0.1, sevenDayUtilization: 0.1 }),
      launchFn: makeLaunchFn({ readUsageTelemetryFn: telemetry({ fiveHourUtilization: 0.1, sevenDayUtilization: 0.1 }) }),
      logger
    });

    const launched = await poller.tick();
    expect(launched).not.toBeNull();
    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0001");
  });

  it("holds a card that does not fit the 5-hour window -- never launched", async () => {
    const orchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "assets" })], { runsDir });
    const logger = makeLogger();
    const poller = createAutoLaunchPoller({
      store: orchestrator.store,
      orchestrator,
      runsDir,
      enabled: true,
      intervalMs: 1000,
      usageMax: 0.8,
      readUsage: async () => ({ utilization: 0, status: "allowed", reason: "status=allowed" }),
      readUsageTelemetryFn: telemetry({ fiveHourUtilization: 0.1, sevenDayUtilization: 0.1 }),
      launchFn: makeLaunchFn({ readUsageTelemetryFn: telemetry({ fiveHourUtilization: 0.1, sevenDayUtilization: 0.1 }) }),
      logger
    });

    expect(await poller.tick()).toBeNull();
    expect(orchestrator.runCard).not.toHaveBeenCalled();
    expect(await listActiveReservations({ runsDir })).toHaveLength(0);
  });

  it("a smaller fitting card behind a non-fitting one is still admitted the same tick", async () => {
    const orchestrator = makeOrchestrator(
      [makeTask({ id: "T-0001", priority: "P0", agent: "assets" }), makeTask({ id: "T-0002", priority: "P1", agent: "infra" })],
      { runsDir }
    );
    const logger = makeLogger();
    const readUsageTelemetryFn = telemetry({ fiveHourUtilization: 0.1, sevenDayUtilization: 0.1 });
    const poller = createAutoLaunchPoller({
      store: orchestrator.store,
      orchestrator,
      runsDir,
      enabled: true,
      intervalMs: 1000,
      usageMax: 0.8,
      readUsage: async () => ({ utilization: 0, status: "allowed", reason: "status=allowed" }),
      readUsageTelemetryFn,
      launchFn: makeLaunchFn({ readUsageTelemetryFn }),
      logger
    });

    const launched = await poller.tick();
    expect(launched?.id).toBe("T-0002");
    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0002");
    expect(orchestrator.runCard).not.toHaveBeenCalledWith("T-0001");
    expect(logger.log.mock.calls.map((c) => c[0]).join("\n")).toMatch(/T-0001 does not fit/);
  });

  it("an unknown (unregistered-type) estimate auto-holds -- never treated as free capacity", async () => {
    const orchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "server" })], { runsDir });
    const logger = makeLogger();
    const readUsageTelemetryFn = telemetry({ fiveHourUtilization: 0.1, sevenDayUtilization: 0.1 });
    const poller = createAutoLaunchPoller({
      store: orchestrator.store,
      orchestrator,
      runsDir,
      enabled: true,
      intervalMs: 1000,
      usageMax: 0.8,
      readUsage: async () => ({ utilization: 0, status: "allowed", reason: "status=allowed" }),
      readUsageTelemetryFn,
      launchFn: makeLaunchFn({ readUsageTelemetryFn }),
      logger
    });

    expect(await poller.tick()).toBeNull();
    expect(orchestrator.runCard).not.toHaveBeenCalled();
  });

  it("an unmeasured 5-hour window auto-holds even with a known estimate", async () => {
    const orchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "infra" })], { runsDir });
    const logger = makeLogger();
    const readUsageTelemetryFn = telemetry({ fiveHourClassification: "unavailable", sevenDayUtilization: 0.1 });
    const poller = createAutoLaunchPoller({
      store: orchestrator.store,
      orchestrator,
      runsDir,
      enabled: true,
      intervalMs: 1000,
      usageMax: 0.8,
      readUsage: async () => ({ utilization: 0, status: "allowed", reason: "status=allowed" }),
      readUsageTelemetryFn,
      launchFn: makeLaunchFn({ readUsageTelemetryFn }),
      logger
    });

    expect(await poller.tick()).toBeNull();
    expect(orchestrator.runCard).not.toHaveBeenCalled();
  });

  it("a weekly shortage holds even with a healthy 5-hour reading", async () => {
    const orchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "infra" })], { runsDir });
    const logger = makeLogger();
    const readUsageTelemetryFn = telemetry({ fiveHourUtilization: 0.05, sevenDayUtilization: 0.98 });
    const poller = createAutoLaunchPoller({
      store: orchestrator.store,
      orchestrator,
      runsDir,
      enabled: true,
      intervalMs: 1000,
      usageMax: 0.8,
      readUsage: async () => ({ utilization: 0, status: "allowed", reason: "status=allowed" }),
      readUsageTelemetryFn,
      launchFn: makeLaunchFn({ readUsageTelemetryFn }),
      logger
    });

    expect(await poller.tick()).toBeNull();
    expect(orchestrator.runCard).not.toHaveBeenCalled();
  });

  it("flag off: the poller launches a normally-non-fitting card unaffected -- enforcement never engages", async () => {
    const orchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "assets" })], { runsDir });
    const logger = makeLogger();
    const readUsageTelemetryFn = telemetry({ fiveHourUtilization: 0.1, sevenDayUtilization: 0.1 });
    // Same as the "holds" test above, except enforcementEnabledFn is left at its default (off).
    const launchFn = ({ orchestrator: o, id, trigger, logger: l }) =>
      launchCardRun({
        orchestrator: o,
        id,
        trigger,
        logger: l,
        buildLaunchDecideFn: (args) =>
          realBuildLaunchDecide({
            ...args,
            readUsageTelemetryFn,
            evaluateAdmissionFn: (evalArgs) => realEvaluateAdmission({ ...evalArgs, unitConversion: UNIT_CONVERSION })
          })
      });
    const poller = createAutoLaunchPoller({
      store: orchestrator.store,
      orchestrator,
      runsDir,
      enabled: true,
      intervalMs: 1000,
      usageMax: 0.8,
      readUsage: async () => ({ utilization: 0, status: "allowed", reason: "status=allowed" }),
      readUsageTelemetryFn,
      launchFn,
      logger
    });

    const launched = await poller.tick();
    expect(launched).not.toBeNull();
    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0001");
  });
});

describe("T-0379 integration: a manual launch (not through the poller), through the real launchCardRun", () => {
  it("proceeds for a non-fitting card and is marked manual_override in the advisory log", async () => {
    const orchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "assets" })], { runsDir });
    const readUsageTelemetryFn = telemetry({ fiveHourUtilization: 0.1, sevenDayUtilization: 0.1 });
    const launchFn = makeLaunchFn({ readUsageTelemetryFn });

    await launchFn({ orchestrator, id: "T-0001", trigger: LAUNCH_TRIGGERS.MANUAL, logger: makeLogger() });

    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0001");
    expect(await listActiveReservations({ runsDir })).toHaveLength(1);

    const advisoryFile = (await fs.readdir(runsDir)).find((f) => f.endsWith(".advisory.json"));
    const record = JSON.parse(await fs.readFile(path.join(runsDir, advisoryFile), "utf8"));
    expect(record.manualOverride).toBeDefined();
  });

  it("proceeds for an unknown estimate and for an unmeasured 5-hour window alike", async () => {
    const unknownEstimateOrchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "server" })], { runsDir });
    const readUsageTelemetryFn = telemetry({ fiveHourUtilization: 0.1, sevenDayUtilization: 0.1 });
    await makeLaunchFn({ readUsageTelemetryFn })({
      orchestrator: unknownEstimateOrchestrator,
      id: "T-0001",
      trigger: LAUNCH_TRIGGERS.MANUAL,
      logger: makeLogger()
    });
    expect(unknownEstimateOrchestrator.runCard).toHaveBeenCalledWith("T-0001");

    const unmeasuredRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), "wip-gate-integration-test-2-"));
    try {
      const unmeasuredOrchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "infra" })], { runsDir: unmeasuredRunsDir });
      const unmeasuredTelemetryFn = telemetry({ fiveHourClassification: "unavailable", sevenDayUtilization: 0.1 });
      await launchCardRun({
        orchestrator: unmeasuredOrchestrator,
        id: "T-0001",
        trigger: LAUNCH_TRIGGERS.MANUAL,
        logger: makeLogger(),
        enforcementEnabledFn: () => true,
        buildLaunchDecideFn: (args) =>
          realBuildLaunchDecide({
            ...args,
            readUsageTelemetryFn: unmeasuredTelemetryFn,
            evaluateAdmissionFn: (evalArgs) => realEvaluateAdmission({ ...evalArgs, unitConversion: UNIT_CONVERSION })
          })
      });
      expect(unmeasuredOrchestrator.runCard).toHaveBeenCalledWith("T-0001");
    } finally {
      await rmRetrying(unmeasuredRunsDir);
    }
  });
});
