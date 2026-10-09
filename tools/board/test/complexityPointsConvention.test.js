/**
 * T-0440 — writes down the complexity_points scoring convention: who sets it, when, and which
 * auto-generated card types are deliberately exempt. No behaviour change: this pins the content
 * of the new doc (docs/complexity-points.md) and confirms the rubric in promptBuilder.js now
 * points at it, without the rubric's own wording changing (that's covered by the pre-existing
 * "gives a one-line rubric for every Fibonacci step" test in promptBuilder.test.js, which still
 * has to pass unmodified against the same step text).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlannerPrompt } from "../src/runner/promptBuilder.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DOC_PATH = path.join(REPO_ROOT, "docs", "complexity-points.md");

function readDoc() {
  return fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, "utf8") : "";
}

const UNASSIGNED_TASK = {
  id: "T-TEST",
  title: "Test task",
  priority: "P2",
  phase: 1,
  agent: null,
  body: "Some task body."
};

describe("docs/complexity-points.md exists and states who scores a card and when", () => {
  it("exists", () => {
    expect(fs.existsSync(DOC_PATH), `expected ${DOC_PATH} to exist`).toBe(true);
  });

  it("states the card's author sets complexity_points at authoring time", () => {
    const doc = readDoc().toLowerCase();
    expect(doc).toContain("authoring time");
  });

  it("states the planner sets it only on the agent === null expansion path", () => {
    const doc = readDoc();
    expect(doc).toMatch(/agent\s*===\s*null/);
  });

  it("points at the rubric's actual location (file + step number) instead of restating it", () => {
    const doc = readDoc();
    expect(doc).toContain("promptBuilder.js");
    expect(doc.toLowerCase()).toContain("step 7");
    // the rubric's own point values should not be re-enumerated here (that would drift)
    expect(doc).not.toMatch(/`13`\s*[-—]\s*a large feature/);
  });
});

describe("docs/complexity-points.md names the auto-generated-stub exemption", () => {
  it("names escalationRemediation.js's dispatch cards", () => {
    const doc = readDoc();
    expect(doc).toContain("escalationRemediation.js");
    expect(doc).toContain("dispatch");
  });

  it("names flowImprovementCard.js's generic flow-health cards", () => {
    const doc = readDoc();
    expect(doc).toContain("flowImprovementCard.js");
    expect(doc.toLowerCase()).toContain("flow-health");
  });

  it("says why sizing these is meaningless, and that an unscored one of these is intended, not an omission", () => {
    const doc = readDoc().toLowerCase();
    expect(doc).toContain("meaningless");
    expect(doc).toMatch(/intended|deliberate/);
    expect(doc).toMatch(/not an omission|not.*somebody forgot/);
  });

  it("clarifies a flow-health card a human picks up and scopes is ordinary work and gets scored normally", () => {
    const doc = readDoc().toLowerCase();
    expect(doc).toMatch(/picks? up|scopes?/);
  });
});

describe("docs/complexity-points.md states what the field does NOT do", () => {
  it("names test/complexityPointsLaunchIsolation.test.js as the isolation guarantee", () => {
    const doc = readDoc();
    expect(doc).toContain("complexityPointsLaunchIsolation.test.js");
  });

  it("points at the USD cost estimate as what the WIP gate actually sizes with", () => {
    const doc = readDoc();
    expect(doc).toContain("costEstimator.js");
  });

  it("is explicit this is never read by launch, admission, auto-launch, or cost paths", () => {
    const doc = readDoc().toLowerCase();
    expect(doc).toContain("launch");
    expect(doc).toContain("admission");
    expect(doc).toContain("cost");
    expect(doc).toContain("never");
  });
});

describe("step 7 of the planner rubric points at docs/complexity-points.md", () => {
  it("the planner expansion prompt's complexity_points step references the new doc", () => {
    const prompt = buildPlannerPrompt({ task: UNASSIGNED_TASK });
    expect(prompt).toContain("docs/complexity-points.md");
  });

  it("the rubric's own step text and point definitions are unchanged", () => {
    const prompt = buildPlannerPrompt({ task: UNASSIGNED_TASK });
    expect(prompt).toContain(
      "Set a `complexity_points` value in the card's frontmatter using this Fibonacci rubric"
    );
    expect(prompt).toContain(
      "`1` -- a one-line or single-value change (a constant, a copy tweak), no new test surface."
    );
    expect(prompt).toContain(
      "`21` -- epic-sized; split it into smaller cards before anyone picks it up rather than leaving it at this size."
    );
  });
});
