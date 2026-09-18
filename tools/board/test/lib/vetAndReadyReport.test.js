import { describe, it, expect } from "vitest";
import { formatDecisionRow, formatDecisionTable, formatPollerSummary, formatReport } from "../../src/lib/vetAndReadyReport.js";

function readyEntry(overrides = {}) {
  return {
    id: "T-0001",
    title: "A card",
    priority: "P1",
    verdict: "ready",
    rule: "5-cap-ok",
    reason: "all rules passed",
    evidence: "",
    ...overrides
  };
}

describe("formatDecisionRow", () => {
  it("labels a readied card distinctly from a skipped one", () => {
    const readyLine = formatDecisionRow(readyEntry());
    const skipLine = formatDecisionRow(readyEntry({ id: "T-0002", verdict: "skip", rule: "1-dependency", reason: "unmet dependency: T-0010 is backlog" }));
    expect(readyLine).toMatch(/READIED/);
    expect(readyLine).toMatch(/T-0001/);
    expect(skipLine).toMatch(/skipped/);
    expect(skipLine).toMatch(/T-0002/);
    expect(skipLine).toMatch(/1-dependency/);
    expect(skipLine).toMatch(/T-0010/);
  });

  it("includes evidence inline when present", () => {
    const line = formatDecisionRow(readyEntry({ verdict: "skip", rule: "2-merged", reason: "possibly satisfied", evidence: "abc1234 feat: T-0001 done" }));
    expect(line).toMatch(/abc1234/);
  });
});

describe("formatDecisionTable", () => {
  it("reports counts and lists readied before skipped", () => {
    const result = {
      eligibleCount: 2,
      cap: 4,
      readied: [readyEntry()],
      skipped: [readyEntry({ id: "T-0002", verdict: "skip", rule: "1-dependency", reason: "unmet dependency" })]
    };
    const table = formatDecisionTable(result);
    expect(table).toMatch(/Eligible-at-all: 2/);
    expect(table).toMatch(/Readied: 1/);
    expect(table).toMatch(/Skipped: 1/);
    expect(table.indexOf("T-0001")).toBeLessThan(table.indexOf("T-0002"));
  });

  it("handles zero eligible cards without listing empty sections", () => {
    const table = formatDecisionTable({ eligibleCount: 0, cap: 4, readied: [], skipped: [] });
    expect(table).toMatch(/Eligible-at-all: 0/);
    expect(table).not.toMatch(/## Readied/);
    expect(table).not.toMatch(/## Skipped/);
  });
});

describe("formatPollerSummary", () => {
  it("reports enabled/interval/usageMax when the poller state is available", () => {
    const summary = formatPollerSummary({ available: true, enabled: true, intervalMs: 18000000, usageMax: 0.8 });
    expect(summary).toMatch(/enabled=true/);
    expect(summary).toMatch(/300m/);
    expect(summary).toMatch(/usageMax=0.8/);
  });

  it("degrades gracefully when the poller endpoint is unavailable, without throwing", () => {
    const summary = formatPollerSummary({ available: false, note: "GET /api/poller returned 404" });
    expect(summary).toMatch(/unavailable/);
    expect(summary).toMatch(/404/);
  });

  it("degrades gracefully when no poller state was supplied at all", () => {
    expect(() => formatPollerSummary(null)).not.toThrow();
    expect(formatPollerSummary(null)).toMatch(/unavailable/);
  });
});

describe("formatReport", () => {
  it("stitches the timestamp, poller summary and decision table into one report", () => {
    const report = formatReport({
      result: { eligibleCount: 0, cap: 4, readied: [], skipped: [] },
      poller: { available: false, note: "not deployed yet" },
      timestamp: "2026-09-18T01:00:00.000Z"
    });
    expect(report).toMatch(/2026-09-18T01:00:00.000Z/);
    expect(report).toMatch(/unavailable/);
    expect(report).toMatch(/Eligible-at-all: 0/);
  });

  it("appends an apply summary section when one is given", () => {
    const report = formatReport({
      result: { eligibleCount: 0, cap: 4, readied: [], skipped: [] },
      poller: { available: false, note: "not deployed yet" },
      timestamp: "2026-09-18T01:00:00.000Z",
      appliedSummary: "Dry run -- nothing written."
    });
    expect(report).toMatch(/Dry run -- nothing written\./);
  });
});
