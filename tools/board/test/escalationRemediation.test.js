import { describe, it, expect } from "vitest";
import {
  isRemediationCardFor,
  findExistingRemediationCard,
  draftRemediationCard
} from "../src/lib/escalationRemediation.js";

const ORIGINAL_TASK = {
  id: "T-0042",
  title: "Wire up the widget",
  priority: "P1",
  phase: 2,
  branch: "feature/T-0042"
};

const REPORT = {
  attempted: "Attempted T-0042 (Wire up the widget) across 5 implementer/reviewer cycles on branch feature/T-0042.",
  failureSignature: "Run 1 of 5: permission denied\nRun 5 of 5: permission denied",
  lacks: { category: "permission-grant", detail: "Bash tool has no grant to write outside worktrees/T-0042" }
};

describe("isRemediationCardFor", () => {
  it("is true for a card carrying the marker for the given original id", () => {
    const card = { body: "<!-- escalation-remediation-for: T-0042 -->\n\nfix it" };
    expect(isRemediationCardFor(card, "T-0042")).toBe(true);
  });

  it("is false for a card carrying the marker for a different original id", () => {
    const card = { body: "<!-- escalation-remediation-for: T-0099 -->\n\nfix it" };
    expect(isRemediationCardFor(card, "T-0042")).toBe(false);
  });

  it("is false for a card with no marker at all", () => {
    expect(isRemediationCardFor({ body: "just a normal card" }, "T-0042")).toBe(false);
  });

  it("is false for a null/undefined body", () => {
    expect(isRemediationCardFor({}, "T-0042")).toBe(false);
    expect(isRemediationCardFor(null, "T-0042")).toBe(false);
  });
});

describe("findExistingRemediationCard", () => {
  it("finds the card among a list of tasks whose body carries the marker for the given id", () => {
    const tasks = [
      { id: "T-0001", body: "unrelated" },
      { id: "T-0050", body: "<!-- escalation-remediation-for: T-0042 -->\n\nfix" },
      { id: "T-0051", body: "<!-- escalation-remediation-for: T-0043 -->\n\nfix" }
    ];
    expect(findExistingRemediationCard(tasks, "T-0042")).toEqual(tasks[1]);
  });

  it("returns null when no matching card exists", () => {
    const tasks = [{ id: "T-0001", body: "unrelated" }];
    expect(findExistingRemediationCard(tasks, "T-0042")).toBeNull();
  });

  it("returns null for an empty task list", () => {
    expect(findExistingRemediationCard([], "T-0042")).toBeNull();
  });
});

describe("draftRemediationCard", () => {
  it("drafts a card in ready status, owned by dispatch, carrying the dedupe marker and the report", () => {
    const fields = draftRemediationCard({
      task: ORIGINAL_TASK,
      report: REPORT,
      attemptCount: 5,
      now: () => new Date("2026-08-14T00:00:00.000Z")
    });

    expect(fields.status).toBe("ready");
    expect(fields.agent).toBe("dispatch");
    expect(fields.depends_on).toEqual([]);
    expect(fields.title).toMatch(/T-0042/);
    expect(fields.body).toContain("<!-- escalation-remediation-for: T-0042 -->");
    expect(fields.body).toContain(REPORT.attempted);
    expect(fields.body).toContain("permission denied");
    expect(fields.body).toContain("Bash tool has no grant to write outside worktrees/T-0042");
    expect(fields.body).toContain("## Acceptance");
  });

  it("carries the original card's priority and phase forward", () => {
    const fields = draftRemediationCard({ task: ORIGINAL_TASK, report: REPORT, attemptCount: 5 });
    expect(fields.priority).toBe("P1");
    expect(fields.phase).toBe(2);
  });
});
