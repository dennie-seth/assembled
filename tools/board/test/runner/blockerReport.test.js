import { describe, it, expect } from "vitest";
import { categorizeFailure, buildBlockerReport, formatBlockerReportComment, BLOCKER_CATEGORIES } from "../../src/runner/blockerReport.js";
import { formatHostActionRequest } from "../../src/lib/hostActionRequest.js";

const TASK = {
  id: "T-0042",
  title: "Wire up the widget",
  branch: "feature/T-0042"
};

const HOST_ACTION = {
  host: "Windows ComfyUI host (F:\\ComfyUI)",
  action: "Edit start-comfyui.bat to set CUBLAS_WORKSPACE_CONFIG=:4096:8, then restart ComfyUI.",
  reason: "No agent has a shell on this host; the launch flags live in a .bat file only a human can edit.",
  verify: "Submit the same seed twice across two server lifetimes and confirm identical output hashes."
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

  it("categorizes a structured host-action-request block as host-action (T-0323)", () => {
    expect(categorizeFailure(formatHostActionRequest(HOST_ACTION))).toBe("host-action");
  });

  it("prefers host-action over a keyword match when both are present in the same text (structural beats heuristic)", () => {
    const text = `permission denied writing to /etc\n\n${formatHostActionRequest(HOST_ACTION)}`;
    expect(categorizeFailure(text)).toBe("host-action");
  });

  it("exposes the full set of categories in a stable order, host-action first", () => {
    expect(BLOCKER_CATEGORIES).toEqual([
      "host-action",
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

  it("carries the parsed structured payload through as lacks.hostAction when a host-action-request block is present (T-0323)", () => {
    const attemptRecords = [
      { attempt: 1, notes: "trying a workaround, no luck" },
      { attempt: 2, notes: `still stuck.\n\n${formatHostActionRequest(HOST_ACTION)}` }
    ];
    const report = buildBlockerReport({ task: TASK, attemptRecords, attemptCount: 2 });
    expect(report.lacks.category).toBe("host-action");
    expect(report.lacks.hostAction).toEqual(HOST_ACTION);
  });

  it("omits hostAction entirely for every other category", () => {
    const attemptRecords = [{ attempt: 1, notes: "permission denied writing to /etc" }];
    const report = buildBlockerReport({ task: TASK, attemptRecords, attemptCount: 1 });
    expect(report.lacks.hostAction ?? null).toBeNull();
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

  it("renders host/action/reason/verify as distinct labeled fields, not folded into prose (T-0323)", () => {
    const report = {
      attempted: "Attempted T-0042 across 5 cycles.",
      failureSignature: "Run 1 of 5: x\nRun 5 of 5: x",
      lacks: { category: "host-action", detail: HOST_ACTION.reason, hostAction: HOST_ACTION }
    };
    const text = formatBlockerReportComment(report);
    expect(text).toContain("Host action required");
    expect(text).toContain(`**Host:** ${HOST_ACTION.host}`);
    expect(text).toContain(`**Action:** ${HOST_ACTION.action}`);
    expect(text).toContain(`**Reason:** ${HOST_ACTION.reason}`);
    expect(text).toContain(`**Verify:** ${HOST_ACTION.verify}`);
  });
});
