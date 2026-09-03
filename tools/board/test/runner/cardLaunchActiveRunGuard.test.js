import { describe, it, expect, vi } from "vitest";
import { launchCardRun, CardLaunchError } from "../../src/runner/cardLaunch.js";

/**
 * Fix-plan item #6 (docs/reviews/2026-09-03-run-lifecycle-state-management.md) -- LOAD-BEARING.
 *
 * `hasActiveRuns()` is the board's only working double-launch protection: the auto-launch
 * poller's second condition ("no in-progress/validation card") is defeated whenever card status
 * drifts, and POST /api/tasks/:id/run never consulted it at all. Its per-card re-entrancy guard
 * is what refused Dennie's duplicate T-0273 click; nothing refused a launch of a *different*
 * card on top of a live run, which is how T-0284 landed on top of T-0243.
 */

function makeOrchestrator({ tasks, activeCardIds = new Set(), running = new Set(), runCard } = {}) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return {
    store: {
      async get(id) {
        return byId.has(id) ? { ...byId.get(id) } : null;
      },
      async update(id, patch) {
        const u = { ...byId.get(id), ...patch };
        byId.set(id, u);
        return u;
      }
    },
    hub: { broadcast: vi.fn() },
    activeCardIds,
    isRunning: (id) => running.has(id),
    hasActiveRuns: () => activeCardIds.size > 0,
    runCard: runCard ?? vi.fn(async () => {})
  };
}

const task = (o = {}) => ({ id: "T-0001", status: "ready", agent: "infra", depends_on: [], body: "", ...o });
const silent = { error: vi.fn(), log: vi.fn() };

async function refusal(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return null;
}

describe("#6 POST /run refuses a launch while another run is active", () => {
  it("allows a legitimate single launch when the board is idle", async () => {
    const runCard = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({ tasks: [task()], runCard });

    const launched = await launchCardRun({ orchestrator, id: "T-0001", logger: silent });

    expect(launched.id).toBe("T-0001");
    expect(runCard).toHaveBeenCalledWith("T-0001");
  });

  it("refuses launching a DIFFERENT card while a run is active", async () => {
    // T-0284 landing on top of a live T-0243 is exactly this.
    const runCard = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({
      tasks: [task({ id: "T-0001" }), task({ id: "T-0002" })],
      activeCardIds: new Set(["T-0001"]),
      running: new Set(["T-0001"]),
      runCard
    });

    const err = await refusal(() => launchCardRun({ orchestrator, id: "T-0002", logger: silent }));

    expect(err).toBeInstanceOf(CardLaunchError);
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/T-0001/);
    expect(runCard).not.toHaveBeenCalled();
  });

  it("refuses even when the phase-level map is momentarily empty (between-phases / retry gap)", async () => {
    // The precise hole: activeRuns (isRunning) empties between the reviewer's FAIL and the next
    // implementer attempt, while activeCardIds -- and therefore hasActiveRuns() -- stays true.
    const runCard = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({
      tasks: [task({ id: "T-0001" }), task({ id: "T-0002" })],
      activeCardIds: new Set(["T-0001"]),
      running: new Set(), // nothing spawned right now
      runCard
    });

    const err = await refusal(() => launchCardRun({ orchestrator, id: "T-0002", logger: silent }));

    expect(err).toBeInstanceOf(CardLaunchError);
    expect(err.statusCode).toBe(409);
    expect(runCard).not.toHaveBeenCalled();
  });

  it("keeps the specific same-card message rather than the board-wide one", async () => {
    const orchestrator = makeOrchestrator({
      tasks: [task({ id: "T-0001" })],
      activeCardIds: new Set(["T-0001"]),
      running: new Set(["T-0001"])
    });

    const err = await refusal(() => launchCardRun({ orchestrator, id: "T-0001", logger: silent }));

    expect(err.message).toBe("Task T-0001 already has an active run");
    expect(err.statusCode).toBe(409);
  });

  it("does not crash on an orchestrator that predates hasActiveRuns()", async () => {
    const runCard = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({ tasks: [task()], runCard });
    delete orchestrator.hasActiveRuns;

    const launched = await launchCardRun({ orchestrator, id: "T-0001", logger: silent });

    expect(launched.id).toBe("T-0001");
    expect(runCard).toHaveBeenCalled();
  });

  it("allows the next launch once the active run finishes", async () => {
    const runCard = vi.fn(async () => {});
    const activeCardIds = new Set(["T-0001"]);
    const orchestrator = makeOrchestrator({
      tasks: [task({ id: "T-0001" }), task({ id: "T-0002" })],
      activeCardIds,
      runCard
    });

    expect(await refusal(() => launchCardRun({ orchestrator, id: "T-0002", logger: silent }))).toBeInstanceOf(
      CardLaunchError
    );

    activeCardIds.clear(); // the run ends
    const launched = await launchCardRun({ orchestrator, id: "T-0002", logger: silent });

    expect(launched.id).toBe("T-0002");
    expect(runCard).toHaveBeenCalledWith("T-0002");
  });
});
