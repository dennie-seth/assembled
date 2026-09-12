import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// T-0368: acceptance criterion 4 requires the planner agent's real, checked-in
// card-authoring guidance -- not just the synthetic prompt built in
// promptBuilder.test.js -- to ask for a complexity_points value with a
// one-line rubric per Fibonacci step. Reads the actual file, same pattern as
// npmGrantAmbiguity.test.js's REAL_AGENTS_DIR.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PLANNER_RULE_PATH = path.join(REPO_ROOT, ".claude", "rules", "planner.md");

describe("planner card-authoring guidance -- complexity_points rubric (T-0368)", () => {
  const guidance = fs.readFileSync(PLANNER_RULE_PATH, "utf8");

  it("asks the planner to set a complexity_points value when authoring or expanding a card", () => {
    expect(guidance).toContain("complexity_points");
  });

  it("gives a one-line rubric for every Fibonacci step (1, 2, 3, 5, 8, 13, 21)", () => {
    for (const step of ["1", "2", "3", "5", "8", "13", "21"]) {
      expect(guidance).toMatch(new RegExp("`" + step + "`\\s*[-—]"));
    }
  });

  it("is explicit that complexity_points is a human planning signal only, never an admission/launch/cost input", () => {
    const lower = guidance.toLowerCase();
    expect(lower).toContain("planning signal only");
    expect(lower).toContain("never");
  });
});
