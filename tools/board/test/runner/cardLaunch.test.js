import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchCardRun, CardLaunchError, RUNNABLE_STATUSES } from "../../src/runner/cardLaunch.js";
import { ROUND_CAP } from "../../src/lib/roundCap.js";
import { listActiveReservations } from "../../src/runner/launchReservation.js";
import { buildLaunchDecide as realBuildLaunchDecide } from "../../src/runner/launchAdvisory.js";

function makeTask(overrides = {}) {
  return {
    id: "T-0001",
    title: "A card",
    status: "ready",
    priority: "P1",
    phase: "P1",
    agent: "server",
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

function makeOrchestrator(tasks, { running = new Set(), runCard } = {}) {
  const store = makeStore(tasks);
  return {
    store,
    hub: { broadcast: vi.fn() },
    isRunning: vi.fn((id) => running.has(id)),
    hasActiveRuns: vi.fn(() => running.size > 0),
    runCard: runCard ?? vi.fn(async () => undefined)
  };
}

/** Polls a real-filesystem-backed condition until it holds, for chains whose reconciliation crosses real fs I/O the setImmediate flush below doesn't wait long enough for. */
async function waitFor(conditionFn, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await conditionFn()) return;
    if (Date.now() >= deadline) throw new Error("waitFor: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Lets a fire-and-forget `runCard().catch(...)` chain settle before assertions. */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("launchCardRun — guards", () => {
  it("exposes the same runnable statuses the Run button accepts", () => {
    expect([...RUNNABLE_STATUSES].sort()).toEqual(["blocked", "ready", "review"]);
  });

  it("throws 501 when no orchestrator is configured", async () => {
    await expect(launchCardRun({ orchestrator: null, id: "T-0001" })).rejects.toMatchObject({
      name: "CardLaunchError",
      statusCode: 501
    });
  });

  it("throws 404 for an unknown card", async () => {
    const orchestrator = makeOrchestrator([]);
    await expect(launchCardRun({ orchestrator, id: "T-9999" })).rejects.toMatchObject({ statusCode: 404 });
    expect(orchestrator.runCard).not.toHaveBeenCalled();
  });

  it.each(["backlog", "in-progress", "validation", "done", "retired"])(
    "throws 409 for a non-runnable status (%s)",
    async (status) => {
      const orchestrator = makeOrchestrator([makeTask({ status })]);
      await expect(launchCardRun({ orchestrator, id: "T-0001" })).rejects.toMatchObject({ statusCode: 409 });
      expect(orchestrator.runCard).not.toHaveBeenCalled();
    }
  );

  it("throws 409 for a card assigned to the non-executable dispatch sentinel", async () => {
    const orchestrator = makeOrchestrator([makeTask({ agent: "dispatch" })]);
    await expect(launchCardRun({ orchestrator, id: "T-0001" })).rejects.toMatchObject({ statusCode: 409 });
    expect(orchestrator.runCard).not.toHaveBeenCalled();
  });

  it("throws 409 when the card already has an active run", async () => {
    const orchestrator = makeOrchestrator([makeTask()], { running: new Set(["T-0001"]) });
    await expect(launchCardRun({ orchestrator, id: "T-0001" })).rejects.toMatchObject({ statusCode: 409 });
    expect(orchestrator.runCard).not.toHaveBeenCalled();
  });

  it("throws 409 and never runs the card when a dependency is unmet", async () => {
    const orchestrator = makeOrchestrator([
      makeTask({ id: "T-0001", depends_on: ["T-0002"] }),
      makeTask({ id: "T-0002", status: "ready" })
    ]);
    await expect(launchCardRun({ orchestrator, id: "T-0001" })).rejects.toMatchObject({ statusCode: 409 });
    expect(orchestrator.runCard).not.toHaveBeenCalled();
  });

  it("throws 409 and never runs the card on a dependency cycle", async () => {
    const orchestrator = makeOrchestrator([
      makeTask({ id: "T-0001", depends_on: ["T-0002"] }),
      makeTask({ id: "T-0002", depends_on: ["T-0001"] })
    ]);
    await expect(launchCardRun({ orchestrator, id: "T-0001" })).rejects.toMatchObject({ statusCode: 409 });
    expect(orchestrator.runCard).not.toHaveBeenCalled();
  });

  it("throws 409 for a card that has settled two rounds without a promoted deliverable (T-0344)", async () => {
    const orchestrator = makeOrchestrator([makeTask({ status: "blocked", round: ROUND_CAP })]);
    await expect(launchCardRun({ orchestrator, id: "T-0001" })).rejects.toMatchObject({ statusCode: 409 });
    expect(orchestrator.runCard).not.toHaveBeenCalled();
  });

  it("409's round-cap message names the required human action", async () => {
    const orchestrator = makeOrchestrator([makeTask({ status: "blocked", round: ROUND_CAP })]);
    await expect(launchCardRun({ orchestrator, id: "T-0001" })).rejects.toMatchObject({
      message: expect.stringMatching(/RESCOPED/)
    });
  });

  it("still refuses above the cap, not just exactly at it", async () => {
    const orchestrator = makeOrchestrator([makeTask({ status: "blocked", round: ROUND_CAP + 3 })]);
    await expect(launchCardRun({ orchestrator, id: "T-0001" })).rejects.toMatchObject({ statusCode: 409 });
    expect(orchestrator.runCard).not.toHaveBeenCalled();
  });

  it("rethrows a non-dependency store failure untouched rather than masking it as a 409", async () => {
    const orchestrator = makeOrchestrator([makeTask()]);
    orchestrator.store.get.mockImplementation(async (id) => {
      if (orchestrator.store.get.mock.calls.length > 1) throw new Error("disk on fire");
      return orchestrator.store.byId.get(id) ?? null;
    });
    await expect(launchCardRun({ orchestrator, id: "T-0001" })).rejects.toThrow("disk on fire");
  });
});

describe("launchCardRun — launch", () => {
  it.each(["ready", "review", "blocked"])("starts the run for a runnable card (%s) and returns it", async (status) => {
    const orchestrator = makeOrchestrator([makeTask({ status })]);
    const task = await launchCardRun({ orchestrator, id: "T-0001" });
    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0001");
    expect(task.id).toBe("T-0001");
  });

  it.each([0, 1])("launches a card below the round cap (round: %i)", async (round) => {
    const orchestrator = makeOrchestrator([makeTask({ status: "blocked", round })]);
    await launchCardRun({ orchestrator, id: "T-0001" });
    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0001");
  });

  it("launches a card that was at the cap but has since been rescoped (round reset to 0)", async () => {
    const orchestrator = makeOrchestrator([
      makeTask({ status: "blocked", round: 0, rescoped_by: "@DennieSeth", rescoped_at: "2026-09-10T12:00:00.000Z" })
    ]);
    await launchCardRun({ orchestrator, id: "T-0001" });
    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0001");
  });

  it("launches a card whose dependencies are all done or retired", async () => {
    const orchestrator = makeOrchestrator([
      makeTask({ id: "T-0001", depends_on: ["T-0002", "T-0003"] }),
      makeTask({ id: "T-0002", status: "done" }),
      makeTask({ id: "T-0003", status: "retired" })
    ]);
    await launchCardRun({ orchestrator, id: "T-0001" });
    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0001");
  });

  it("returns without waiting for the run to finish", async () => {
    let settle;
    const runCard = vi.fn(() => new Promise((resolve) => (settle = resolve)));
    const orchestrator = makeOrchestrator([makeTask()], { runCard });
    await launchCardRun({ orchestrator, id: "T-0001" });
    expect(runCard).toHaveBeenCalled();
    settle();
  });

  it("persists a run failure as blocked with a Run Failed note and broadcasts it", async () => {
    const runCard = vi.fn(async () => {
      throw new Error("spawn failed");
    });
    const orchestrator = makeOrchestrator([makeTask()], { runCard });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await launchCardRun({ orchestrator, id: "T-0001", logger });
    await flush();

    expect(orchestrator.store.update).toHaveBeenCalledWith(
      "T-0001",
      expect.objectContaining({ status: "blocked", body: expect.stringContaining("Run Failed") })
    );
    expect(orchestrator.hub.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "changed", id: "T-0001" }));
    expect(logger.error).toHaveBeenCalled();
  });

  it("swallows a failure to persist the run failure rather than surfacing an unhandled rejection", async () => {
    const runCard = vi.fn(async () => {
      throw new Error("spawn failed");
    });
    const orchestrator = makeOrchestrator([makeTask()], { runCard });
    orchestrator.store.update.mockRejectedValue(new Error("store is gone"));
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await launchCardRun({ orchestrator, id: "T-0001", logger });
    await flush();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});

describe("CardLaunchError", () => {
  it("carries an HTTP-shaped status code the API layer can map directly", () => {
    const err = new CardLaunchError("nope", 409);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CardLaunchError");
    expect(err.statusCode).toBe(409);
  });
});

describe("launchCardRun — advisory + reservation at the shared launch boundary (WIP gate T-D)", () => {
  let runsDir;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cardLaunch-advisory-test-"));
  });

  afterEach(async () => {
    // A test's fire-and-forget reconciliation (runCardPromise.then(...) inside launchCardRun)
    // can still be mid-write when the test itself returns -- retry rm across that real-fs race
    // rather than letting a stray ENOTEMPTY fail an unrelated test.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await fs.rm(runsDir, { recursive: true, force: true });
        return;
      } catch (err) {
        if (err.code !== "ENOTEMPTY" || attempt === 9) throw err;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  });

  function makeAdvisoryOrchestrator(tasks, opts = {}) {
    const orchestrator = makeOrchestrator(tasks, opts);
    orchestrator.runsDir = runsDir;
    return orchestrator;
  }

  it("reserves budget and records an advisory decision before launching, without refusing or delaying it", async () => {
    const orchestrator = makeAdvisoryOrchestrator([makeTask({ agent: "infra" })]);
    await launchCardRun({ orchestrator, id: "T-0001" });
    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0001");

    const reservations = await listActiveReservations({ runsDir });
    expect(reservations).toHaveLength(1);
    expect(reservations[0].cardId).toBe("T-0001");

    const advisoryFiles = (await fs.readdir(runsDir)).filter((f) => f.endsWith(".advisory.json"));
    expect(advisoryFiles).toHaveLength(1);
  });

  it("releases the reservation and attaches a completed outcome once the run finishes successfully", async () => {
    let resolveRun;
    const runCard = vi.fn(() => new Promise((resolve) => (resolveRun = resolve)));
    const orchestrator = makeAdvisoryOrchestrator([makeTask({ agent: "infra" })], { runCard });
    await launchCardRun({ orchestrator, id: "T-0001" });

    expect(await listActiveReservations({ runsDir })).toHaveLength(1);

    resolveRun();
    await waitFor(async () => (await listActiveReservations({ runsDir })).length === 0);

    const advisoryFile = (await fs.readdir(runsDir)).find((f) => f.endsWith(".advisory.json"));
    const record = JSON.parse(await fs.readFile(path.join(runsDir, advisoryFile), "utf8"));
    expect(record.outcome).not.toBeNull();
  });

  it("releases the reservation, records a failed outcome, and still posts the existing Run Failed note when the run rejects", async () => {
    const runCard = vi.fn(async () => {
      throw new Error("spawn failed");
    });
    const orchestrator = makeAdvisoryOrchestrator([makeTask({ agent: "infra" })], { runCard });
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await launchCardRun({ orchestrator, id: "T-0001", logger });
    await waitFor(async () => (await listActiveReservations({ runsDir })).length === 0);

    expect(orchestrator.store.update).toHaveBeenCalledWith("T-0001", expect.objectContaining({ status: "blocked" }));
    expect(orchestrator.hub.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "changed", id: "T-0001" }));
  });

  it("never refuses or delays the launch even when the advisory pipeline itself is broken", async () => {
    const orchestrator = makeAdvisoryOrchestrator([makeTask({ agent: "infra" })]);
    // A file, not a directory, at the runsDir path -- every mkdir/readdir/writeFile the advisory
    // and reservation machinery attempts underneath it fails with ENOTDIR.
    const blockedPath = path.join(runsDir, "blocked-file");
    await fs.writeFile(blockedPath, "x");
    orchestrator.runsDir = blockedPath;

    await expect(launchCardRun({ orchestrator, id: "T-0001" })).resolves.toBeDefined();
    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0001");
  });

  it("skips the advisory/reservation machinery entirely for an orchestrator with no runsDir (older/minimal test doubles)", async () => {
    const orchestrator = makeOrchestrator([makeTask({ agent: "infra" })]);
    await launchCardRun({ orchestrator, id: "T-0001" });
    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0001");
  });

  it("T-0370 (Codex finding 7): reserves against the card's own max_attempts override, not the fixed MAX_AUTO_RETRY_ATTEMPTS", async () => {
    const orchestrator = makeAdvisoryOrchestrator([makeTask({ agent: "infra", max_attempts: 20 })]);
    let passedMaxAttempts = null;
    const buildLaunchDecideFn = vi.fn((args) => {
      passedMaxAttempts = args.maxAttempts;
      return async () => ({ estimate: { value: null, unit: "usd" }, telemetryReadings: {}, reason: "stub", admission: null });
    });
    await launchCardRun({ orchestrator, id: "T-0001", buildLaunchDecideFn });
    expect(passedMaxAttempts).toBe(20);
  });

  it("T-0370 (Codex finding 7): falls back to the runner's own MAX_AUTO_RETRY_ATTEMPTS default when the card carries no override", async () => {
    const orchestrator = makeAdvisoryOrchestrator([makeTask({ agent: "infra" })]);
    let passedMaxAttempts = null;
    const buildLaunchDecideFn = vi.fn((args) => {
      passedMaxAttempts = args.maxAttempts;
      return async () => ({ estimate: { value: null, unit: "usd" }, telemetryReadings: {}, reason: "stub", admission: null });
    });
    await launchCardRun({ orchestrator, id: "T-0001", buildLaunchDecideFn });
    expect(passedMaxAttempts).toBe(5);
  });

  it("two simultaneous controlled launches (different cards) cannot reserve the same remaining capacity -- each gets its own lease, and the sum reflects both", async () => {
    const orchestrator = makeAdvisoryOrchestrator([
      makeTask({ id: "T-0001", agent: "infra" }),
      makeTask({ id: "T-0002", agent: "infra" })
    ]);

    await Promise.all([launchCardRun({ orchestrator, id: "T-0001" }), launchCardRun({ orchestrator, id: "T-0002" })]);

    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0001");
    expect(orchestrator.runCard).toHaveBeenCalledWith("T-0002");

    const reservations = await listActiveReservations({ runsDir });
    expect(reservations).toHaveLength(2);
    const byCard = Object.fromEntries(reservations.map((r) => [r.cardId, r.reservedCostUsd]));
    // Neither launch's reservation write clobbered the other's -- both are present with their
    // own full reserved amount, and a later admission check reading `reservedUnspentCostUsd`
    // sees the sum of both, never just one.
    expect(byCard["T-0001"]).toBeGreaterThan(0);
    expect(byCard["T-0002"]).toBeGreaterThan(0);
    expect(byCard["T-0001"]).toBeCloseTo(byCard["T-0002"]);
  });

  it("T-0370 (Codex finding 1): two DIFFERENT launches through the real launchCardRun boundary are serialized -- the pool is never overbooked by the recorded decisions", async () => {
    const orchestrator = makeAdvisoryOrchestrator([
      makeTask({ id: "T-0001", agent: "infra" }),
      makeTask({ id: "T-0002", agent: "infra" })
    ]);

    // Wraps the REAL buildLaunchDecide (production logic, not hand-composed primitives -- see
    // Codex's own note that the prior race probe overbooked by construction because it never
    // went through this function) just to capture what it computed, for the assertion below.
    const records = {};
    const buildLaunchDecideFn = (args) => {
      const decide = realBuildLaunchDecide(args);
      return async () => {
        const record = await decide();
        records[args.cardId] = record;
        return record;
      };
    };

    await Promise.all([
      launchCardRun({ orchestrator, id: "T-0001", buildLaunchDecideFn }),
      launchCardRun({ orchestrator, id: "T-0002", buildLaunchDecideFn })
    ]);

    const a = records["T-0001"];
    const b = records["T-0002"];
    expect(a.reservedUnspentCostUsd).not.toBeNull();
    expect(b.reservedUnspentCostUsd).not.toBeNull();
    // The read-check-reserve section is serialized: exactly one of the two launches' admission
    // reads happened BEFORE the other had written its own lease (sees 0 others), and the other
    // happened after (sees the first's full reserved amount) -- never both computed against a
    // shared, stale empty pool, which is what would let the combined demand overbook capacity.
    const sawOthersReservation = [a, b].filter((r) => r.reservedUnspentCostUsd > 0);
    expect(sawOthersReservation).toHaveLength(1);
  });
});
