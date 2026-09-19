import { describe, it, expect, vi } from "vitest";
import { RunOrchestrator } from "../../src/runner/runOrchestrator.js";
import { createAutoPullPoller } from "../../src/runner/autoPullPoller.js";
import { createRestartCoordinator } from "../../src/runner/serviceRestart.js";

/**
 * T-0385 FIX ROUND 1 (Codex review 2026-09-19, P2). The deployed service no longer runs any file
 * watcher at all -- see DEPLOY.md's "No file watcher on the deployed service" section -- so the
 * ONLY thing that can ever restart it while it's up is the guarded restart-on-pull path
 * (autoPullPoller.js -> serviceRestart.js's createRestartCoordinator), which already reads
 * `orchestrator.hasActiveRuns()` (activeCardIds.size > 0) rather than the deploy-time
 * `detectLiveRun` heuristic (pgrep + tasks/.runs/*.jsonl recency) the removed watcher used and
 * which Codex showed can't see a run still in worktree setup (no claude process yet, no run log
 * yet). This file proves that surviving path is correctly guarded across exactly the window
 * Codex's probe hit -- from the moment a real `RunOrchestrator.runCard()` adds the card to
 * `activeCardIds` (before `git.addWorktree`) through to the run's own end -- using a real
 * orchestrator, not a stand-in that hand-sets `hasActiveRuns()`.
 */

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeStore(task) {
  const tasks = new Map([[task.id, { ...task }]]);
  return {
    async get(id) {
      return tasks.has(id) ? { ...tasks.get(id) } : null;
    },
    async update(id, patch) {
      const merged = { ...tasks.get(id), ...patch, id };
      tasks.set(id, merged);
      return { ...merged };
    }
  };
}

/**
 * A real RunOrchestrator whose `git.addWorktree` stays pending until the test resolves it --
 * this holds a real runCard() span exactly in the setup window: `activeCardIds` already has the
 * card (set at the top of runCard(), before addWorktree), but no run log has been created yet
 * (createRunLogFn only runs after addWorktree resolves) and no runner/claude process has spawned.
 * Resolving `addWorktreeGate.reject` (worktree creation "fails") drives the run straight to
 * `_blocked` and its normal cleanup -- activeCardIds empties and `onIdle` fires -- without needing
 * to fake an entire implementer/reviewer phase.
 */
function makeOrchestrator({ addWorktreeGate, onIdle, taskId = "T-0001" }) {
  const store = makeStore({ id: taskId, status: "ready", agent: "infra", depends_on: [], body: "" });
  const git = {
    addWorktree: vi.fn(() => addWorktreeGate.promise)
  };
  return new RunOrchestrator({
    store,
    hub: { broadcast: vi.fn() },
    runner: {},
    git,
    github: { checkAvailability: vi.fn(async () => ({ available: false })) },
    repoRoot: "/repo",
    worktreesDir: "/repo/worktrees",
    runsDir: "/repo/tasks/.runs",
    agentsDir: "/repo/.claude/agents",
    rulesDir: "/repo/.claude/rules",
    taskStoreKind: "db", // skips the git.commitTaskFile branch in _updateAndBroadcast -- irrelevant here
    heartbeatIntervalMs: 0, // no periodic writeRunState -- irrelevant to this guard
    ensureExecutionIdFn: vi.fn(async () => "exec-test"),
    clearExecutionIdFn: vi.fn(async () => {}),
    clearRunStateFn: vi.fn(async () => {}),
    onIdle: onIdle ?? (() => {})
  });
}

describe("T-0385 FIX ROUND 1: guarded restart-on-pull across a real run's setup window", () => {
  it("defers a pull-triggered restart while a real card run is in worktree setup (no run log, no process yet), and fires it once that run ends", async () => {
    const addWorktreeGate = deferred();
    addWorktreeGate.promise.catch(() => {}); // the eventual rejection is expected; don't warn on it
    const restartSpy = vi.fn();
    const logger = makeLogger();
    const restartCoordinator = createRestartCoordinator({ restart: restartSpy, enabled: true, logger });
    const orchestrator = makeOrchestrator({
      addWorktreeGate,
      onIdle: () => restartCoordinator.notifyIdle()
    });

    const runPromise = orchestrator.runCard("T-0001");
    // Let runCard() proceed through activeCardIds.add() and up to the pending addWorktree call.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(orchestrator.hasActiveRuns()).toBe(true); // setup window: card is tracked...
    expect(orchestrator.activeRuns.has("T-0001")).toBe(false); // ...but no phase/process has started

    // Mirrors httpApi.js's Done-triggered pull (handlePatchTask): a pull that lands elsewhere in
    // the board always happens, reading `orchestrator.hasActiveRuns()` fresh right after, and
    // handing it straight to the restart coordinator -- the exact integration point Codex's P2
    // was about. This is the real orchestrator's real signal, not a hand-set boolean.
    restartCoordinator.notifyPulled({ hasActiveRuns: orchestrator.hasActiveRuns() });

    expect(restartSpy).not.toHaveBeenCalled();
    expect(restartCoordinator.pending).toBe(true);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("develop pulled while a card run is active -- restart deferred until idle")
    );

    // The run ends (worktree creation "fails" -- the shortest real path to activeCardIds going
    // back to empty and onIdle firing, without faking a whole implementer/reviewer phase).
    addWorktreeGate.reject(new Error("disk full"));
    await runPromise;

    expect(orchestrator.hasActiveRuns()).toBe(false);
    expect(restartSpy).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("deferred restart: active run finished"));
  });

  it("restarts immediately on a pull when no card run is active at all", async () => {
    const restartSpy = vi.fn();
    const logger = makeLogger();
    const restartCoordinator = createRestartCoordinator({ restart: restartSpy, enabled: true, logger });
    const orchestrator = makeOrchestrator({ addWorktreeGate: deferred() });

    expect(orchestrator.hasActiveRuns()).toBe(false);

    const poller = createAutoPullPoller({
      repoRoot: "/repo",
      orchestrator,
      restartCoordinator,
      enabled: true,
      intervalMs: 60_000,
      git: {
        isBehindOrigin: vi.fn(async () => true),
        pullDevelop: vi.fn(async () => ({ advanced: true, before: "aaaaaaa", after: "bbbbbbb" }))
      },
      logger
    });

    await poller.tick();

    expect(restartSpy).toHaveBeenCalledTimes(1);
    expect(restartCoordinator.pending).toBe(false);
  });

  it("autoPullPoller itself skips the whole tick (no fetch, no pull, no restart) while a real run is in setup, and resumes once idle", async () => {
    const addWorktreeGate = deferred();
    addWorktreeGate.promise.catch(() => {});
    const restartSpy = vi.fn();
    const logger = makeLogger();
    const restartCoordinator = createRestartCoordinator({ restart: restartSpy, enabled: true, logger });
    const orchestrator = makeOrchestrator({
      addWorktreeGate,
      onIdle: () => restartCoordinator.notifyIdle()
    });
    const git = {
      isBehindOrigin: vi.fn(async () => true),
      pullDevelop: vi.fn(async () => ({ advanced: true, before: "aaaaaaa", after: "bbbbbbb" }))
    };
    const poller = createAutoPullPoller({
      repoRoot: "/repo",
      orchestrator,
      restartCoordinator,
      enabled: true,
      intervalMs: 60_000,
      git,
      logger
    });

    const runPromise = orchestrator.runCard("T-0001");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(orchestrator.hasActiveRuns()).toBe(true);

    await poller.tick();

    expect(git.isBehindOrigin).not.toHaveBeenCalled();
    expect(git.pullDevelop).not.toHaveBeenCalled();
    expect(restartSpy).not.toHaveBeenCalled();

    addWorktreeGate.reject(new Error("disk full"));
    await runPromise;
    expect(orchestrator.hasActiveRuns()).toBe(false);

    await poller.tick();

    expect(git.isBehindOrigin).toHaveBeenCalledTimes(1);
    expect(git.pullDevelop).toHaveBeenCalledTimes(1);
    expect(restartSpy).toHaveBeenCalledTimes(1);
  });
});
