import { describe, it, expect, vi } from "vitest";
import { launchCardRun, CardLaunchError } from "../../src/runner/cardLaunch.js";

/**
 * Fix-plan item #6 (docs/reviews/2026-09-03-run-lifecycle-state-management.md), reworked.
 *
 * The guard is deliberately SAME-CARD ONLY. An earlier revision of this PR refused any launch
 * while any run was active, which would also have refused deliberate cross-card concurrency --
 * and that demonstrably works: on 2026-09-03 T-0290 (infra) and T-0273 (assets) ran side by side
 * for 11 minutes with separate pids, worktrees and runstate files, and both reached real
 * verdicts. Running two different cards at once is a capability, not a bug.
 *
 * The genuine hole was narrower: `isRunning(id)` reads the phase-level `activeRuns` map, which
 * empties between the reviewer's FAIL and the next implementer attempt (and between phases
 * generally) while the card is still very much in flight. A re-launch landing in that window
 * would start a second run of the SAME card. Consulting `activeCardIds` -- the span-level set
 * `runCard` holds for its whole lifetime -- closes it without touching concurrency.
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

describe("#6 launching a DIFFERENT card while one runs is ALLOWED (concurrency preserved)", () => {
  it("starts a second, different card while the first is mid-run", async () => {
    const runCard = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({
      tasks: [task({ id: "T-0001" }), task({ id: "T-0002" })],
      activeCardIds: new Set(["T-0001"]),
      running: new Set(["T-0001"]),
      runCard
    });

    const launched = await launchCardRun({ orchestrator, id: "T-0002", logger: silent });

    expect(launched.id).toBe("T-0002");
    expect(runCard).toHaveBeenCalledWith("T-0002");
  });

  it("allows a different card even in the between-phases window of the running one", async () => {
    const runCard = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({
      tasks: [task({ id: "T-0001" }), task({ id: "T-0002" })],
      activeCardIds: new Set(["T-0001"]),
      running: new Set(), // T-0001 is between phases -- still in flight, no child spawned
      runCard
    });

    const launched = await launchCardRun({ orchestrator, id: "T-0002", logger: silent });

    expect(launched.id).toBe("T-0002");
    expect(runCard).toHaveBeenCalledWith("T-0002");
  });

  it("allows a third card while two are already running", async () => {
    // The board is not a one-at-a-time queue; nothing here counts active runs.
    const runCard = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({
      tasks: [task({ id: "T-0001" }), task({ id: "T-0002" }), task({ id: "T-0003" })],
      activeCardIds: new Set(["T-0001", "T-0002"]),
      running: new Set(["T-0001", "T-0002"]),
      runCard
    });

    const launched = await launchCardRun({ orchestrator, id: "T-0003", logger: silent });

    expect(launched.id).toBe("T-0003");
    expect(runCard).toHaveBeenCalledWith("T-0003");
  });

  it("still launches normally on a completely idle board", async () => {
    const runCard = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({ tasks: [task()], runCard });

    const launched = await launchCardRun({ orchestrator, id: "T-0001", logger: silent });

    expect(launched.id).toBe("T-0001");
    expect(runCard).toHaveBeenCalledWith("T-0001");
  });
});

describe("#6 re-launching the SAME card is still refused", () => {
  it("refuses a duplicate launch while its phase is running", async () => {
    // The refusal Dennie hit on the duplicate T-0273 click.
    const runCard = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({
      tasks: [task({ id: "T-0001" })],
      activeCardIds: new Set(["T-0001"]),
      running: new Set(["T-0001"]),
      runCard
    });

    const err = await refusal(() => launchCardRun({ orchestrator, id: "T-0001", logger: silent }));

    expect(err).toBeInstanceOf(CardLaunchError);
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe("Task T-0001 already has an active run");
    expect(runCard).not.toHaveBeenCalled();
  });

  it("refuses a duplicate launch in the between-phases window -- the gap this fix closes", async () => {
    // isRunning() is false here: activeRuns empties between the reviewer's FAIL and the next
    // implementer attempt. Before this change the launch went through and started a second run
    // of a card already in flight.
    const runCard = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({
      tasks: [task({ id: "T-0001" })],
      activeCardIds: new Set(["T-0001"]),
      running: new Set(),
      runCard
    });

    const err = await refusal(() => launchCardRun({ orchestrator, id: "T-0001", logger: silent }));

    expect(err).toBeInstanceOf(CardLaunchError);
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe("Task T-0001 already has an active run");
    expect(runCard).not.toHaveBeenCalled();
  });

  it("allows the same card again once its run finishes", async () => {
    const runCard = vi.fn(async () => {});
    const activeCardIds = new Set(["T-0001"]);
    const orchestrator = makeOrchestrator({ tasks: [task({ id: "T-0001" })], activeCardIds, runCard });

    expect(await refusal(() => launchCardRun({ orchestrator, id: "T-0001", logger: silent }))).toBeInstanceOf(
      CardLaunchError
    );

    activeCardIds.clear(); // the run ends
    const launched = await launchCardRun({ orchestrator, id: "T-0001", logger: silent });

    expect(launched.id).toBe("T-0001");
    expect(runCard).toHaveBeenCalledWith("T-0001");
  });

  it("does not crash on an orchestrator with no activeCardIds (older callers, test doubles)", async () => {
    const runCard = vi.fn(async () => {});
    const orchestrator = makeOrchestrator({ tasks: [task()], runCard });
    delete orchestrator.activeCardIds;

    const launched = await launchCardRun({ orchestrator, id: "T-0001", logger: silent });

    expect(launched.id).toBe("T-0001");
    expect(runCard).toHaveBeenCalled();
  });
});
