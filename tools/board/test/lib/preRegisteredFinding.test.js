import { describe, it, expect } from "vitest";
import {
  PRE_REGISTRATION_HEADING,
  FINDING_HEADING,
  hasPreRegisteredExperiment,
  readFindingSection,
  parseFindingEvidencePaths,
  isDecisiveFinding,
  checkFindingWithEvidence
} from "../../src/lib/preRegisteredFinding.js";

/**
 * T-0342: "finding with evidence" is a first-class PASS for `deliverable_type: artifact` cards,
 * but only when the finding was pre-registered (DL-21 style) BEFORE the run that produced it.
 * See docs/PLAN.md and the T-0342 card body for the motivating case (T-0259 session 13: a real,
 * pre-registered falsifying result FAILed anyway because only a promoted artifact counted).
 */

describe("hasPreRegisteredExperiment", () => {
  it("is true when the heading is present with non-empty content", () => {
    const body = `## Context\nsome stuff\n\n${PRE_REGISTRATION_HEADING}\nIf X, the arm is falsified.\n\n## Acceptance\n- [ ] ...\n`;
    expect(hasPreRegisteredExperiment(body)).toBe(true);
  });

  it("is false when the heading is absent entirely", () => {
    const body = `## Context\nsome stuff\n\n## Acceptance\n- [ ] ...\n`;
    expect(hasPreRegisteredExperiment(body)).toBe(false);
  });

  it("is false when the heading is present but has no content before the next heading", () => {
    const body = `${PRE_REGISTRATION_HEADING}\n\n## Acceptance\n- [ ] ...\n`;
    expect(hasPreRegisteredExperiment(body)).toBe(false);
  });

  it("is false for an empty or missing body", () => {
    expect(hasPreRegisteredExperiment("")).toBe(false);
    expect(hasPreRegisteredExperiment(undefined)).toBe(false);
  });

  it("captures content up to the next top-level heading only, not a nested subheading", () => {
    const body = `${PRE_REGISTRATION_HEADING}\n### Subheading still part of the section\nprediction text\n\n## Finding\nsomething else\n`;
    // Still true (non-empty content before the next ## heading)
    expect(hasPreRegisteredExperiment(body)).toBe(true);
  });
});

describe("readFindingSection / parseFindingEvidencePaths / isDecisiveFinding", () => {
  it("extracts the Finding section text", () => {
    const body = `## Context\n...\n\n${FINDING_HEADING}\nThe result is decisive: arm falsified. See \`docs/assets/evidence/T-0999/frame.png\`.\n\n## Do not\n...\n`;
    expect(readFindingSection(body)).toContain("decisive");
  });

  it("returns an empty string when there is no Finding section", () => {
    expect(readFindingSection("## Context\nnothing here\n")).toBe("");
  });

  it("extracts backtick-quoted, extensioned file paths, deduped and in order", () => {
    const text =
      "Attempt 8's `docs/assets/evidence/T-0999/attempt_8_main.png` confirms the drift; " +
      "compare against `docs/assets/evidence/T-0999/attempt_1_main.png` again and " +
      "`docs/assets/evidence/T-0999/attempt_8_main.png` once more.";
    expect(parseFindingEvidencePaths(text)).toEqual([
      "docs/assets/evidence/T-0999/attempt_8_main.png",
      "docs/assets/evidence/T-0999/attempt_1_main.png"
    ]);
  });

  it("ignores backtick spans that aren't extensioned file paths (inline commands, bare words)", () => {
    const text = "Run `npm test` and check `main`, not a path.";
    expect(parseFindingEvidencePaths(text)).toEqual([]);
  });

  it("isDecisiveFinding requires the literal word 'decisive' (case-insensitive)", () => {
    expect(isDecisiveFinding("The result is Decisive: falsified.")).toBe(true);
    expect(isDecisiveFinding("the result is decisive")).toBe(true);
    expect(isDecisiveFinding("inconclusive, more attempts needed")).toBe(false);
    expect(isDecisiveFinding("")).toBe(false);
  });
});

describe("checkFindingWithEvidence", () => {
  const evidencePath = "docs/assets/evidence/T-0999/attempt_8_main.png";

  function task(overrides = {}) {
    return {
      id: "T-0999",
      deliverable_type: "artifact",
      body: "",
      ...overrides
    };
  }

  it("is not applicable when beforeBody has no pre-registered experiment", async () => {
    const result = await checkFindingWithEvidence({
      task: task({ body: `${FINDING_HEADING}\ndecisive result, see \`${evidencePath}\`\n` }),
      beforeBody: "## Context\nnothing pre-registered\n",
      repoRoot: "/repo",
      fileExists: async () => true
    });
    expect(result).toEqual({ ok: false, applicable: false, errors: [] });
  });

  it("is NOT satisfied by a pre-registration that exists only in the CURRENT body, not beforeBody (the anti-retroactive-registration guarantee)", async () => {
    const currentBody =
      `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n\n` +
      `${FINDING_HEADING}\ndecisive result, see \`${evidencePath}\`\n`;
    const result = await checkFindingWithEvidence({
      task: task({ body: currentBody }),
      beforeBody: "## Context\nno pre-registration was here before the run\n",
      repoRoot: "/repo",
      fileExists: async () => true
    });
    expect(result.applicable).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("applicable but FAILs when pre-registered but the current body has no Finding section at all", async () => {
    const result = await checkFindingWithEvidence({
      task: task({ body: "## Context\nno finding written yet\n" }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async () => true
    });
    expect(result.applicable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain(FINDING_HEADING);
  });

  it("FAILs when the Finding section does not say the result is decisive", async () => {
    const result = await checkFindingWithEvidence({
      task: task({ body: `${FINDING_HEADING}\nInconclusive so far, see \`${evidencePath}\`\n` }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async () => true
    });
    expect(result.applicable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/decisive/i);
  });

  it("FAILs when the Finding section is decisive but cites no evidence file", async () => {
    const result = await checkFindingWithEvidence({
      task: task({ body: `${FINDING_HEADING}\nThe result is decisive: arm falsified, trust me.\n` }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async () => true
    });
    expect(result.applicable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/cites no evidence file/i);
  });

  it("FAILs when a cited evidence file does not actually exist on disk", async () => {
    const result = await checkFindingWithEvidence({
      task: task({ body: `${FINDING_HEADING}\nThe result is decisive: see \`${evidencePath}\`\n` }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async () => false
    });
    expect(result.applicable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain(evidencePath);
    expect(result.errors.join(" ")).toMatch(/does not exist|no file exists/i);
  });

  it("PASSes when pre-registered before the run, and the finding is decisive with existing cited evidence", async () => {
    const result = await checkFindingWithEvidence({
      task: task({ body: `${FINDING_HEADING}\nThe result is decisive: arm falsified. See \`${evidencePath}\`.\n` }),
      beforeBody: `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`,
      repoRoot: "/repo",
      fileExists: async () => true
    });
    expect(result).toEqual({ ok: true, applicable: true, errors: [] });
  });
});
