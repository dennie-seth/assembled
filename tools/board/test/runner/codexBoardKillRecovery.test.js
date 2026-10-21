import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrphanReaper } from "../../src/runner/orphanReaper.js";
import { writeRunState } from "../../src/runner/runState.js";
import { rmTemp } from "../helpers/rmTemp.js";

/**
 * T-0460 edge case: "Kill the board mid-review" -- the one leg the prior VALIDATION round found
 * "not exercised at all, mocked or real." Exercised here, mocked, via the board's EXISTING
 * crash-recovery machinery (orphanReaper.js) rather than any Codex-specific recovery code --
 * there is none, and this is the test that proves none is needed. `runCodexReview.js` now writes
 * a runstate record the identical way `runOrchestrator.js`'s `_runPhase` does for every other
 * agent (right after `runner.start()` returns), so a Codex review in flight when the board
 * process dies leaves the exact same liveness evidence on disk any other phase would.
 */

function makeTask(overrides = {}) {
  return {
    id: "T-0460-subject",
    title: "Codex review subject card",
    status: "in-progress",
    agent: "codex-reviewer",
    body: "## Context\n\nsomething under review\n",
    ...overrides
  };
}

function makeStore(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return {
    async list() {
      return [...byId.values()];
    },
    async update(id, patch) {
      const existing = byId.get(id);
      if (!existing) throw new Error(`Task ${id} not found`);
      const updated = { ...existing, ...patch };
      byId.set(id, updated);
      return updated;
    },
    _byId: byId
  };
}

function makeHub() {
  return { broadcast: () => {} };
}

describe("Codex review survives the board process dying mid-review (mocked -- reuses orphanReaper.js)", () => {
  let runsDir;

  afterEach(async () => {
    await rmTemp(runsDir);
  });

  it("re-adopts the subject card rather than reaping it when the detached codex child outlives the dead board process", async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-board-kill-alive-"));
    const task = makeTask();
    const store = makeStore([task]);
    const hub = makeHub();

    // What the adapter did: nothing special -- it wrote this runstate the same instant any other
    // agent's phase would have (right after runner.start() returned), then the board process that
    // wrote it died. The codex child itself is spawned detached (see codexCliRunner.js), so it
    // keeps running under its own pid independent of the board's lifetime -- mocked here via an
    // injected isPidAliveFn, the same pattern orphanReaper.test.js already uses for this exact
    // "pid confirmed alive" case, rather than racing a real process.
    await writeRunState({ runsDir, taskId: task.id, pid: 4242, runLogPath: path.join(runsDir, `${task.id}-fake.jsonl`) });

    // What the board saw: a fresh restart has zero in-memory activeCardIds -- reapOnStartup is
    // the entry point that exists precisely for this case.
    const reaper = createOrphanReaper({ store, hub, activeCardIds: new Set(), enabled: true, runsDir, isPidAliveFn: (pid) => pid === 4242 });

    const reaped = await reaper.reapOnStartup();

    // What the subject card was left showing: still in-progress, untouched -- readopted as a live
    // run, not reaped out from under the review in flight.
    expect(reaped).toEqual([]);
    expect(store._byId.get(task.id).status).toBe("in-progress");
  });

  it("reaps the subject card to blocked with a recovery note when the codex child died along with the board", async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-board-kill-dead-"));
    const task = makeTask();
    const store = makeStore([task]);
    const hub = makeHub();

    // Stale heartbeat (written "30 minutes ago") plus a confirmed-dead pid and no corroborating
    // fresh run log -- the same "genuinely dead" shape orphanReaper.test.js's own T-0243/T-0999
    // cases use, applied here to a Codex review's runstate instead of a Claude one.
    await writeRunState({
      runsDir,
      taskId: task.id,
      pid: 4243,
      runLogPath: path.join(runsDir, `${task.id}-fake.jsonl`),
      now: () => new Date(Date.now() - 30 * 60_000)
    });

    const reaper = createOrphanReaper({ store, hub, activeCardIds: new Set(), enabled: true, runsDir, isPidAliveFn: () => false });

    const reaped = await reaper.reapOnStartup();

    expect(reaped).toEqual([task.id]);
    const updated = store._byId.get(task.id);
    expect(updated.status).toBe("blocked");
    expect(updated.body).toMatch(/run did not complete \(board restarted or process ended before a verdict\); reset to blocked for re-run\./);
  });
});
