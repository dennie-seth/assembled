import { describe, it, expect } from "vitest";
import { buildPrTitle, buildPrBody } from "../../src/runner/prBuilder.js";

const TASK = {
  id: "T-0200",
  title: "Add finalize step to Agent Runner",
  body: "## Context\nAuto-open a PR on PASS.\n\n## Acceptance\n- [ ] gh pr create runs on PASS\n"
};

describe("buildPrTitle", () => {
  it("formats as 'T-XXXX: <card title>'", () => {
    expect(buildPrTitle({ task: TASK })).toBe("T-0200: Add finalize step to Agent Runner");
  });
});

describe("buildPrBody", () => {
  it("includes the card's own story/acceptance body verbatim", () => {
    const body = buildPrBody({ task: TASK, verdict: { verdict: "PASS", notes: "ran tests, all green" } });
    expect(body).toContain("## Context");
    expect(body).toContain("Auto-open a PR on PASS.");
    expect(body).toContain("## Acceptance");
    expect(body).toContain("gh pr create runs on PASS");
  });

  it("includes the reviewer's PASS verdict and captured test/lint notes", () => {
    const body = buildPrBody({ task: TASK, verdict: { verdict: "PASS", notes: "npm test: 611 passed; lint clean" } });
    expect(body).toMatch(/PASS/);
    expect(body).toContain("npm test: 611 passed; lint clean");
  });

  it("falls back to a placeholder when the verdict has no notes, rather than inventing content", () => {
    const body = buildPrBody({ task: TASK, verdict: { verdict: "PASS", notes: "" } });
    expect(body).toContain("(no notes recorded)");
  });
});
