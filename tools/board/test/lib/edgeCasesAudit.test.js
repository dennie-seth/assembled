import { describe, it, expect } from "vitest";
import { hasEdgeCasesBlock, auditEdgeCasesCoverage } from "../../src/lib/edgeCasesAudit.js";

describe("hasEdgeCasesBlock -- the single definition of a 'real' block (T-0408)", () => {
  it("is false when there is no ## Acceptance section at all", () => {
    expect(hasEdgeCasesBlock("## Context\nnothing here\n")).toBe(false);
  });

  it("is false for an empty or missing body", () => {
    expect(hasEdgeCasesBlock("")).toBe(false);
    expect(hasEdgeCasesBlock(undefined)).toBe(false);
  });

  it("is false when Acceptance has checklist items but no **Edge cases:** label", () => {
    const body = "## Acceptance\n- [ ] works\n- [ ] also works\n";
    expect(hasEdgeCasesBlock(body)).toBe(false);
  });

  it("is true for a bold-label block with at least one checklist item under it", () => {
    const body = "## Acceptance\n- [ ] works\n\n**Edge cases:**\n- [ ] handles empty input\n";
    expect(hasEdgeCasesBlock(body)).toBe(true);
  });

  it("is false when the label exists but carries no checklist items before the next heading", () => {
    const body = "## Acceptance\n- [ ] works\n\n**Edge cases:**\n\n## Notes\nsomething else\n";
    expect(hasEdgeCasesBlock(body)).toBe(false);
  });

  it("is false when the phrase only appears as a mention elsewhere, not a bold label line", () => {
    const body = "## Acceptance\n- [ ] works\n\nSee the edge cases discussed in the design doc.\n";
    expect(hasEdgeCasesBlock(body)).toBe(false);
  });

  it("is false when the label appears only past the next heading, outside ## Acceptance", () => {
    const body = "## Acceptance\n- [ ] works\n\n## Notes\n**Edge cases:**\n- [ ] too late\n";
    expect(hasEdgeCasesBlock(body)).toBe(false);
  });

  it("is false for a heading-form '### Edge cases' block -- a heading is never a label", () => {
    const body = "## Acceptance\n- [ ] works\n\n### Edge cases\n- [ ] boundary case\n";
    expect(hasEdgeCasesBlock(body)).toBe(false);
  });

  it("is true for a qualified '## Acceptance (...)' heading with a compliant block (T-0405 shape)", () => {
    const body = "## Acceptance (story-level -- planner expands)\n- [ ] works\n\n**Edge cases:**\n- [ ] boundary case\n";
    expect(hasEdgeCasesBlock(body)).toBe(true);
  });
});

function task(overrides = {}) {
  return {
    id: "T-0001",
    agent: "infra",
    created: "2026-01-01",
    body: "## Acceptance\n- [ ] works\n",
    ...overrides
  };
}

const WITH_BLOCK = "## Acceptance\n- [ ] works\n\n**Edge cases:**\n- [ ] boundary case\n";
const WITHOUT_BLOCK = "## Acceptance\n- [ ] works\n";

describe("auditEdgeCasesCoverage -- re-runnable board-wide measurement (T-0408)", () => {
  it("counts total cards and how many carry a real block", () => {
    const tasks = [
      task({ id: "T-0001", body: WITH_BLOCK }),
      task({ id: "T-0002", body: WITHOUT_BLOCK }),
      task({ id: "T-0003", body: WITHOUT_BLOCK })
    ];
    const report = auditEdgeCasesCoverage(tasks);
    expect(report.total).toEqual({ cards: 3, withBlock: 1 });
  });

  it("breaks the count down by agent, including an 'unassigned' bucket for a null agent", () => {
    const tasks = [
      task({ id: "T-0001", agent: "infra", body: WITH_BLOCK }),
      task({ id: "T-0002", agent: "infra", body: WITHOUT_BLOCK }),
      task({ id: "T-0003", agent: "assets", body: WITHOUT_BLOCK }),
      task({ id: "T-0004", agent: null, body: WITHOUT_BLOCK })
    ];
    const report = auditEdgeCasesCoverage(tasks);
    expect(report.byAgent.infra).toEqual({ cards: 2, withBlock: 1 });
    expect(report.byAgent.assets).toEqual({ cards: 1, withBlock: 0 });
    expect(report.byAgent.unassigned).toEqual({ cards: 1, withBlock: 0 });
  });

  it("reports the newest N cards by `created` date, defaulting to 25", () => {
    const tasks = Array.from({ length: 30 }, (_, i) =>
      task({
        id: `T-${String(i + 1).padStart(4, "0")}`,
        created: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
        body: i < 5 ? WITH_BLOCK : WITHOUT_BLOCK
      })
    );
    const report = auditEdgeCasesCoverage(tasks);
    expect(report.newest.n).toBe(25);
    expect(report.newest.cards).toBe(25);
  });

  it("honors a custom newestN option", () => {
    const tasks = [
      task({ id: "T-0001", created: "2026-01-03", body: WITH_BLOCK }),
      task({ id: "T-0002", created: "2026-01-02", body: WITHOUT_BLOCK }),
      task({ id: "T-0003", created: "2026-01-01", body: WITHOUT_BLOCK })
    ];
    const report = auditEdgeCasesCoverage(tasks, { newestN: 2 });
    expect(report.newest.n).toBe(2);
    expect(report.newest.cards).toBe(2);
    expect(report.newest.withBlock).toBe(1);
  });

  it("orders 'newest' by `created` descending, most recent first", () => {
    const tasks = [
      task({ id: "T-0001", created: "2026-01-01", body: WITHOUT_BLOCK }),
      task({ id: "T-0002", created: "2026-03-01", body: WITH_BLOCK }),
      task({ id: "T-0003", created: "2026-02-01", body: WITHOUT_BLOCK })
    ];
    const report = auditEdgeCasesCoverage(tasks, { newestN: 1 });
    expect(report.newest.cards).toBe(1);
    expect(report.newest.withBlock).toBe(1);
  });

  it("returns all-zero counts for an empty task list", () => {
    const report = auditEdgeCasesCoverage([]);
    expect(report.total).toEqual({ cards: 0, withBlock: 0 });
    expect(report.newest.cards).toBe(0);
    expect(report.byAgent).toEqual({});
  });
});
