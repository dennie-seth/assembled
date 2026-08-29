import { describe, it, expect, vi } from "vitest";
import { launchCardRun, CardLaunchError, RUNNABLE_STATUSES } from "../../src/runner/cardLaunch.js";

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
