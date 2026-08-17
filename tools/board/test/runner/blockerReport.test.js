import { describe, it, expect } from "vitest";
import { categorizeFailure, buildBlockerReport, formatBlockerReportComment, BLOCKER_CATEGORIES } from "../../src/runner/blockerReport.js";

const TASK = {
  id: "T-0042",
  title: "Wire up the widget",
  branch: "feature/T-0042"
};

describe("categorizeFailure", () => {
  it("categorizes a permission/grant failure", () => {
    expect(categorizeFailure("Bash tool denied: permission denied writing to /etc")).toBe("permission-grant");
  });

  it("categorizes a missing-tool failure", () => {
    expect(categorizeFailure("Error: unknown tool 'Godot' -- not permitted to use it")).toBe("tool");
  });

  it("categorizes an environment/dependency failure", () => {
    expect(categorizeFailure("Cannot find module 'sqlite3' -- ENOENT, is it installed?")).toBe("env-dependency");
  });

  it("categorizes an external-service failure", () => {
    expect(categorizeFailure("fetch failed: ECONNREFUSED connecting to ComfyUI at 127.0.0.1:8188")).toBe("external-service");
  });

  it("categorizes a design-ambiguity failure", () => {
    expect(categorizeFailure("The acceptance criteria are ambiguous about which endpoint should own this field")).toBe(
      "design-ambiguity"
    );
  });

  it("falls back to code/test bug when nothing else matches", () => {
    expect(categorizeFailure("Expected 3 but received 2 -- assertion failed in boardView.test.js:44")).toBe("code-test-bug");
  });

  it("exposes the full set of categories in a stable order", () => {
    expect(BLOCKER_CATEGORIES).toEqual([
      "permission-grant",
      "tool",
      "env-dependency",
      "external-service",
      "design-ambiguity",
      "code-test-bug"
    ]);
  });
});

describe("buildBlockerReport", () => {
  it("summarizes what was attempted, the failure signature across attempts, and what it lacks", () => {
    const attemptRecords = [
      { attempt: 1, notes: "permission denied writing to worktrees/T-0042/tools/board/config.json" },
      { attempt: 2, notes: "permission denied writing to worktrees/T-0042/tools/board/config.json again" }
    ];

    const report = buildBlockerReport({ task: TASK, attemptRecords, attemptCount: 2 });

    expect(report.attempted).toMatch(/T-0042/);
    expect(report.attempted).toMatch(/2/);
    expect(report.attempted).toMatch(/feature\/T-0042/);
    expect(report.failureSignature).toContain("Run 1 of 2");
    expect(report.failureSignature).toContain("Run 2 of 2");
    expect(report.failureSignature).toContain("permission denied writing to worktrees/T-0042/tools/board/config.json");
    expect(report.lacks.category).toBe("permission-grant");
    expect(report.lacks.detail).toContain("again");
  });

  it("uses the last attempt's notes as the detail excerpt", () => {
    const attemptRecords = [
      { attempt: 1, notes: "assertion failed on first pass" },
      { attempt: 2, notes: "assertion failed on second pass" },
      { attempt: 3, notes: "assertion failed on third pass, different line" }
    ];
    const report = buildBlockerReport({ task: TASK, attemptRecords, attemptCount: 3 });
    expect(report.lacks.category).toBe("code-test-bug");
    expect(report.lacks.detail).toBe("assertion failed on third pass, different line");
  });
});

describe("formatBlockerReportComment", () => {
  it("renders a structured, human-readable comment body", () => {
    const report = {
      attempted: "Attempted T-0042 across 5 cycles.",
      failureSignature: "Run 1 of 5: x\nRun 5 of 5: x",
      lacks: { category: "tool", detail: "Godot binary not on PATH" }
    };
    const text = formatBlockerReportComment(report);
    expect(text).toContain("Blocker report");
    expect(text).toContain("Attempted T-0042 across 5 cycles.");
    expect(text).toContain("Run 1 of 5: x");
    expect(text).toContain("Tool");
    expect(text).toContain("Godot binary not on PATH");
  });
});
