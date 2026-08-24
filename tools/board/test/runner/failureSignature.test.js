import { describe, it, expect } from "vitest";
import { computeFailureSignature, normalizeFailureText } from "../../src/runner/failureSignature.js";

describe("normalizeFailureText", () => {
  it("strips timestamps, pids, run ids, and worktree paths", () => {
    const normalized = normalizeFailureText(
      "Failed at 2026-08-24T10:15:30.123Z (pid 12345) in /repo/worktrees/T-0224/foo.js (run-id abc-123-def) after 12.3s"
    );
    expect(normalized).not.toMatch(/2026-08-24/);
    expect(normalized).not.toMatch(/12345/);
    expect(normalized).not.toMatch(/worktrees\/T-0224/);
    expect(normalized).not.toMatch(/abc-123-def/);
    expect(normalized).not.toMatch(/12\.3s/);
  });

  it("leaves the stable error text intact", () => {
    const normalized = normalizeFailureText("assertion failed: expected 3 but received 2 in boardView.test.js:44");
    expect(normalized).toContain("assertion failed");
    expect(normalized).toContain("boardView.test.js:44");
  });

  it("returns an empty string for non-string input", () => {
    expect(normalizeFailureText(undefined)).toBe("");
    expect(normalizeFailureText(null)).toBe("");
  });
});

describe("computeFailureSignature", () => {
  it("hashes equal for the same underlying failure with different timestamps/pids/worktree paths/run ids", () => {
    const a = computeFailureSignature({
      phase: "reviewer",
      verdict: "FAIL",
      notes:
        "Assertion failed at 2026-08-24T10:15:30.123Z (pid 12345) in /repo/worktrees/T-0224/tools/board/src/thing.js after 12.3s (run-id abc-123-def)"
    });
    const b = computeFailureSignature({
      phase: "reviewer",
      verdict: "FAIL",
      notes:
        "Assertion failed at 2026-08-24T11:02:05.001Z (pid 99981) in /repo/worktrees/T-0224-retry2/tools/board/src/thing.js after 45.0s (run-id xyz-987-uvw)"
    });
    expect(a).toBe(b);
  });

  it("hashes differently when the underlying error text differs", () => {
    const a = computeFailureSignature({ phase: "reviewer", verdict: "FAIL", notes: "assertion failed in thing.test.js" });
    const b = computeFailureSignature({ phase: "reviewer", verdict: "FAIL", notes: "permission denied writing to /etc/hosts" });
    expect(a).not.toBe(b);
  });

  it("hashes differently for a different failing phase, same text", () => {
    const a = computeFailureSignature({ phase: "implementer", verdict: "FAIL", notes: "same underlying text" });
    const b = computeFailureSignature({ phase: "reviewer", verdict: "FAIL", notes: "same underlying text" });
    expect(a).not.toBe(b);
  });

  it("hashes differently for a different verdict, same text", () => {
    const a = computeFailureSignature({ phase: "reviewer", verdict: "FAIL", notes: "same underlying text" });
    const b = computeFailureSignature({ phase: "reviewer", verdict: "PASS", notes: "same underlying text" });
    expect(a).not.toBe(b);
  });

  it("returns a stable 64-char hex digest", () => {
    const sig = computeFailureSignature({ phase: "reviewer", verdict: "FAIL", notes: "x" });
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(computeFailureSignature({ phase: "reviewer", verdict: "FAIL", notes: "x" })).toBe(sig);
  });
});
