import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchCardRun, LAUNCH_TRIGGERS, CardLaunchError } from "../../src/runner/cardLaunch.js";
import { acquireGpuLease, readGpuLease } from "../../src/runner/gpuLease.js";
import { listActiveReservations } from "../../src/runner/launchReservation.js";
import { rmTemp } from "../helpers/rmTemp.js";

/**
 * T-0371 (WIP gate T-E) acceptance: "One shared lease per constrained GPU or ComfyUI server ...
 * is acquired atomically with admission and released on completion, failure and cancel, and a
 * test proves a second controlled GPU launch cannot acquire it while it is held." Exercised
 * through the REAL `launchCardRun` boundary (not hand-composed primitives), mirroring
 * wipGateAutoManualIntegration.test.js's own approach for T-0370/T-0379.
 *
 * `GPU_LEASE_ENABLED` defaults off -- every test here passes `gpuLeaseEnabledFn: () => true`
 * explicitly, so the default-off behaviour (acceptance: "no launch that happens today is
 * refused") is exercised by simply NOT passing that override, done in its own describe block
 * below.
 */

function makeTask(overrides = {}) {
  return {
    id: "T-0001",
    title: "A card",
    status: "ready",
    priority: "P1",
    phase: "P7",
    agent: "assets",
    depends_on: [],
    created: "2026-09-11",
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
    activeCardIds: new Set(),
    runCard: runCard ?? vi.fn(async () => undefined)
  };
}

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function rmRetrying(dir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rmTemp(dir);
      return;
    } catch (err) {
      if (err.code !== "ENOTEMPTY" || attempt === 9) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

let runsDir;

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpu-lease-cardlaunch-test-"));
});

afterEach(async () => {
  await rmRetrying(runsDir);
});

describe("GPU_LEASE_ENABLED on: launchCardRun acquires/releases the shared GPU lease for asset/audio cards", () => {
  it("acquires the GPU lease before launching a GPU-consuming (assets) card, and releases it once the run completes", async () => {
    let resolveRun;
    const runCard = vi.fn(() => new Promise((resolve) => (resolveRun = resolve)));
    const orchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "assets" })], { runsDir, runCard });
    const logger = makeLogger();

    await launchCardRun({ orchestrator, id: "T-0001", trigger: LAUNCH_TRIGGERS.MANUAL, logger, gpuLeaseEnabledFn: () => true });

    // The run is in flight -- the lease is held.
    expect(await readGpuLease({ runsDir })).toMatchObject({ cardId: "T-0001" });

    resolveRun();
    await vi.waitFor(async () => {
      expect(await readGpuLease({ runsDir })).toBeNull();
    });
  });

  it("does NOT acquire a GPU lease for a non-GPU (infra) card", async () => {
    const orchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "infra" })], { runsDir });
    const logger = makeLogger();

    await launchCardRun({ orchestrator, id: "T-0001", trigger: LAUNCH_TRIGGERS.MANUAL, logger, gpuLeaseEnabledFn: () => true });

    expect(await readGpuLease({ runsDir })).toBeNull();
    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0001");
  });

  it("refuses a second GPU-consuming (audio) launch while the first (assets) card's lease is held -- and never calls runCard for the refused one", async () => {
    let resolveFirstRun;
    const firstRunCard = vi.fn(() => new Promise((resolve) => (resolveFirstRun = resolve)));
    const orchestrator = makeOrchestrator(
      [makeTask({ id: "T-0001", agent: "assets" }), makeTask({ id: "T-0002", agent: "audio" })],
      { runsDir, runCard: firstRunCard }
    );
    const logger = makeLogger();

    await launchCardRun({ orchestrator, id: "T-0001", trigger: LAUNCH_TRIGGERS.MANUAL, logger, gpuLeaseEnabledFn: () => true });
    expect(await readGpuLease({ runsDir })).toMatchObject({ cardId: "T-0001" });

    await expect(
      launchCardRun({ orchestrator, id: "T-0002", trigger: LAUNCH_TRIGGERS.MANUAL, logger, gpuLeaseEnabledFn: () => true })
    ).rejects.toBeInstanceOf(CardLaunchError);

    expect(orchestrator.runCard).not.toHaveBeenCalledWith("T-0002");
    // The first card's lease is untouched by the second's refused attempt.
    expect(await readGpuLease({ runsDir })).toMatchObject({ cardId: "T-0001" });
    resolveFirstRun();
  });

  it("releasing the token reservation of a refused GPU launch -- capacity is not left dangling for a launch that never started", async () => {
    const orchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "assets" }), makeTask({ id: "T-0002", agent: "audio" })], {
      runsDir,
      runCard: vi.fn(() => new Promise(() => {}))
    });
    const logger = makeLogger();

    await launchCardRun({ orchestrator, id: "T-0001", trigger: LAUNCH_TRIGGERS.MANUAL, logger, gpuLeaseEnabledFn: () => true });
    const reservationsAfterFirst = await listActiveReservations({ runsDir });
    expect(reservationsAfterFirst).toHaveLength(1);

    await expect(
      launchCardRun({ orchestrator, id: "T-0002", trigger: LAUNCH_TRIGGERS.MANUAL, logger, gpuLeaseEnabledFn: () => true })
    ).rejects.toBeInstanceOf(CardLaunchError);

    // The refused launch's own token reservation was released, not left dangling -- only the
    // first (still-running) card's reservation remains active.
    const reservationsAfter = await listActiveReservations({ runsDir });
    expect(reservationsAfter.map((r) => r.cardId)).toEqual(["T-0001"]);
  });

  it("releases the GPU lease when the run fails", async () => {
    const orchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "assets" })], {
      runsDir,
      runCard: vi.fn(async () => {
        throw new Error("boom");
      })
    });
    const logger = makeLogger();

    await launchCardRun({ orchestrator, id: "T-0001", trigger: LAUNCH_TRIGGERS.MANUAL, logger, gpuLeaseEnabledFn: () => true });

    await vi.waitFor(async () => {
      expect(await readGpuLease({ runsDir })).toBeNull();
    });
  });

  it("a second launch of a different GPU card succeeds once the first's lease is released", async () => {
    const orchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "assets" }), makeTask({ id: "T-0002", agent: "audio" })], {
      runsDir,
      runCard: vi.fn(async () => undefined)
    });
    const logger = makeLogger();

    await launchCardRun({ orchestrator, id: "T-0001", trigger: LAUNCH_TRIGGERS.MANUAL, logger, gpuLeaseEnabledFn: () => true });
    await vi.waitFor(async () => {
      expect(await readGpuLease({ runsDir })).toBeNull();
    });

    await launchCardRun({ orchestrator, id: "T-0002", trigger: LAUNCH_TRIGGERS.MANUAL, logger, gpuLeaseEnabledFn: () => true });
    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0002");
  });
});

describe("GPU_LEASE_ENABLED off (default): no launch that happens today is refused", () => {
  it("two GPU-consuming cards both launch even while the first is still 'in flight' -- no gpuLeaseEnabledFn override at all", async () => {
    const orchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "assets" }), makeTask({ id: "T-0002", agent: "audio" })], {
      runsDir,
      runCard: vi.fn(() => new Promise(() => {}))
    });
    const logger = makeLogger();

    await launchCardRun({ orchestrator, id: "T-0001", trigger: LAUNCH_TRIGGERS.MANUAL, logger });
    await launchCardRun({ orchestrator, id: "T-0002", trigger: LAUNCH_TRIGGERS.MANUAL, logger });

    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0001");
    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0002");
    expect(await readGpuLease({ runsDir })).toBeNull();
  });

  it("[FIX ROUND 1] a throwing buildLaunchDecideFn does not block the launch when the flag is off, even for a GPU (assets) card", async () => {
    const orchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "assets" })], {
      runsDir,
      runCard: vi.fn(async () => undefined)
    });
    const logger = makeLogger();
    const buildLaunchDecideFn = () => {
      throw new Error("setup failed");
    };

    await launchCardRun({ orchestrator, id: "T-0001", trigger: LAUNCH_TRIGGERS.MANUAL, logger, buildLaunchDecideFn });

    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0001");
  });
});

/**
 * FIX ROUND 1 (Chat round-2 review of #407, head 41890678, finding 1 -- P1): the GPU lease
 * previously sat INSIDE the advisory pipeline's own `launch()` callback, which the pipeline
 * deliberately never reaches on a setup error (a throwing `buildLaunchDecideFn`, a throwing/hung
 * `decide()`) when token enforcement is off, or on a manual override even when it is on -- so a
 * launch could reach `orchestrator.runCard(id)` with the GPU flag on and NO lease ever attempted.
 * Chat reproduced this through the real `launchCardRun`: a real lease held by another card, GPU
 * leasing on, token enforcement off, `buildLaunchDecideFn` throwing -- the fake worker for a
 * second assets card was launched while the other card still held the lease.
 *
 * These regressions drive the fix: GPU acquisition must be a hard gate on every route to
 * `orchestrator.runCard`, independent of whether the advisory/token pipeline itself succeeded,
 * failed open, or was bypassed by a manual override.
 */
describe("FIX ROUND 1: the GPU lease gate is independent of the advisory pipeline's own fail-open behaviour", () => {
  it("Chat's exact repro -- a real lease held by T-OTHER, GPU leasing on, token enforcement off, buildLaunchDecideFn throwing: the second assets card must not reach the worker", async () => {
    await acquireGpuLease({ runsDir, cardId: "T-OTHER", executionId: "exec-other", invocationId: "inv-other", owner: "cardLaunch:T-OTHER" });

    const orchestrator = makeOrchestrator([makeTask({ id: "T-0002", agent: "assets" })], { runsDir });
    const logger = makeLogger();
    const buildLaunchDecideFn = () => {
      throw new Error("setup failed");
    };

    await expect(
      launchCardRun({
        orchestrator,
        id: "T-0002",
        trigger: LAUNCH_TRIGGERS.MANUAL,
        logger,
        gpuLeaseEnabledFn: () => true,
        enforcementEnabledFn: () => false,
        buildLaunchDecideFn
      })
    ).rejects.toMatchObject({ name: "CardLaunchError", statusCode: 409 });

    expect(orchestrator.runCard).not.toHaveBeenCalled();
    // T-OTHER's lease is untouched by the refused attempt.
    expect(await readGpuLease({ runsDir })).toMatchObject({ cardId: "T-OTHER" });
  });

  it("lease filesystem error -- acquisition fails with an I/O error (not GpuLeaseHeldError): the launch refuses and the token reservation it already wrote is released", async () => {
    const orchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "assets" })], { runsDir });
    const logger = makeLogger();
    const acquireGpuLeaseFn = vi.fn(async () => {
      throw new Error("EACCES: permission denied, open '.gpu-leases/comfyui-primary.gpu-lease.json.tmp'");
    });

    await expect(
      launchCardRun({
        orchestrator,
        id: "T-0001",
        trigger: LAUNCH_TRIGGERS.MANUAL,
        logger,
        gpuLeaseEnabledFn: () => true,
        enforcementEnabledFn: () => false,
        acquireGpuLeaseFn
      })
    ).rejects.toMatchObject({ name: "CardLaunchError", statusCode: 409 });

    expect(orchestrator.runCard).not.toHaveBeenCalled();
    // The token reservation this launch's own (real) advisory pipeline wrote before the GPU
    // acquisition failed is released, not left dangling.
    expect(await listActiveReservations({ runsDir })).toHaveLength(0);
  });

  it("manual launch, token enforcement on -- a real lease held by T-OTHER with buildLaunchDecideFn throwing still refuses, no worker reached", async () => {
    await acquireGpuLease({ runsDir, cardId: "T-OTHER", executionId: "exec-other", invocationId: "inv-other", owner: "cardLaunch:T-OTHER" });

    const orchestrator = makeOrchestrator([makeTask({ id: "T-0002", agent: "assets" })], { runsDir });
    const logger = makeLogger();
    const buildLaunchDecideFn = () => {
      throw new Error("setup failed");
    };

    await expect(
      launchCardRun({
        orchestrator,
        id: "T-0002",
        trigger: LAUNCH_TRIGGERS.MANUAL,
        logger,
        gpuLeaseEnabledFn: () => true,
        enforcementEnabledFn: () => true,
        buildLaunchDecideFn
      })
    ).rejects.toMatchObject({ name: "CardLaunchError", statusCode: 409 });

    expect(orchestrator.runCard).not.toHaveBeenCalled();
  });

  it("manual launch, token enforcement on -- a lease filesystem I/O error still refuses, no worker reached, reservation released", async () => {
    const orchestrator = makeOrchestrator([makeTask({ id: "T-0001", agent: "assets" })], { runsDir });
    const logger = makeLogger();
    const acquireGpuLeaseFn = vi.fn(async () => {
      throw new Error("EACCES: permission denied");
    });

    await expect(
      launchCardRun({
        orchestrator,
        id: "T-0001",
        trigger: LAUNCH_TRIGGERS.MANUAL,
        logger,
        gpuLeaseEnabledFn: () => true,
        enforcementEnabledFn: () => true,
        acquireGpuLeaseFn
      })
    ).rejects.toMatchObject({ name: "CardLaunchError", statusCode: 409 });

    expect(orchestrator.runCard).not.toHaveBeenCalled();
    expect(await listActiveReservations({ runsDir })).toHaveLength(0);
  });
});
