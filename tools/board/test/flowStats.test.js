import { describe, it, expect } from "vitest";
import { computeFlowStats, STATUS_KEYS } from "../src/lib/flowStats.js";

function note(heading, text = "details") {
  return `## ${heading} (2026-08-01T00:00:00.000Z)\n\n${text}\n`;
}

function task(overrides = {}) {
  return {
    id: "T-0001",
    status: "backlog",
    attempts: 0,
    body: "",
    ...overrides
  };
}

describe("computeFlowStats", () => {
  it("returns zeroed-out stats for an empty task list, with no NaN anywhere", () => {
    const stats = computeFlowStats([]);

    expect(stats.totalCards).toBe(0);
    for (const key of STATUS_KEYS) {
      expect(stats.byStatus[key]).toBe(0);
    }
    expect(stats.reworkTotal).toBe(0);
    expect(stats.passTotal).toBe(0);
    expect(stats.reworkSample).toBe(0);
    expect(stats.reworkRate).toBe(0);
    expect(stats.recoveredTotal).toBe(0);
    expect(stats.retryCapBlockedCount).toBe(0);
    expect(stats.avgReworkPerDoneCard).toBe(0);
  });

  it("counts cards per status", () => {
    const stats = computeFlowStats([
      task({ id: "T-0001", status: "done" }),
      task({ id: "T-0002", status: "done" }),
      task({ id: "T-0003", status: "blocked" }),
      task({ id: "T-0004", status: "in-progress" })
    ]);

    expect(stats.totalCards).toBe(4);
    expect(stats.byStatus.done).toBe(2);
    expect(stats.byStatus.blocked).toBe(1);
    expect(stats.byStatus["in-progress"]).toBe(1);
    expect(stats.byStatus.backlog).toBe(0);
  });

  it("counts Validation: FAIL and Validation: PASS notes across bodies and derives reworkRate", () => {
    const stats = computeFlowStats([
      task({ id: "T-0001", status: "done", body: note("Validation: FAIL") + note("Validation: PASS") }),
      task({ id: "T-0002", status: "done", body: note("Validation: PASS") }),
      task({ id: "T-0003", status: "blocked", body: note("Validation: FAIL") })
    ]);

    expect(stats.reworkTotal).toBe(2);
    expect(stats.passTotal).toBe(2);
    expect(stats.reworkSample).toBe(4);
    expect(stats.reworkRate).toBeCloseTo(0.5);
  });

  it("does not match FAIL/PASS text that isn't the exact note heading", () => {
    const stats = computeFlowStats([
      task({
        id: "T-0001",
        status: "backlog",
        body: "The Validation: FAIL rate looks bad, but this is prose, not a note heading.\n"
      })
    ]);

    expect(stats.reworkTotal).toBe(0);
    expect(stats.passTotal).toBe(0);
  });

  it("counts Recovered notes (orphan-reaper interventions) separately from FAIL/PASS", () => {
    const stats = computeFlowStats([
      task({ id: "T-0001", status: "blocked", body: note("Recovered", "run did not complete") }),
      task({ id: "T-0002", status: "blocked", body: note("Recovered") + note("Recovered") })
    ]);

    expect(stats.recoveredTotal).toBe(3);
  });

  it("counts blocked cards that hit the auto-retry cap, distinct from other blocked reasons", () => {
    const stats = computeFlowStats([
      task({
        id: "T-0001",
        status: "blocked",
        body: note("Validation: FAIL", "some notes\n\n(run 5 of 5) Auto-retry limit reached -- blocked for human review.")
      }),
      task({ id: "T-0002", status: "blocked", body: note("Recovered", "run did not complete") }),
      task({ id: "T-0003", status: "blocked", body: note("Blocked", "push to review failed") })
    ]);

    expect(stats.retryCapBlockedCount).toBe(1);
  });

  it("computes avgReworkPerDoneCard from FAIL notes on cards currently done, ignoring non-done cards", () => {
    const stats = computeFlowStats([
      task({ id: "T-0001", status: "done", body: note("Validation: FAIL") + note("Validation: FAIL") + note("Validation: PASS") }),
      task({ id: "T-0002", status: "done", body: note("Validation: PASS") }),
      task({ id: "T-0003", status: "blocked", body: note("Validation: FAIL").repeat(5) })
    ]);

    // 2 FAILs on T-0001, 0 on T-0002, T-0003 excluded (not done) => (2 + 0) / 2 done cards
    expect(stats.avgReworkPerDoneCard).toBeCloseTo(1);
  });
});
