import { describe, it, expect } from "vitest";
import { CODEX_VERDICT_OUTCOMES, validateCodexVerdictPayload } from "../../src/runner/codexVerdictSchema.js";

function validPayload(overrides = {}) {
  return {
    job: { jobId: "job-1", ticketId: "T-0460", sprintId: "sprint-7" },
    reviewedSha: "a".repeat(40),
    acceptanceCriteriaVersion: "2026-10-21",
    outcome: "PASS",
    findings: [],
    checksPerformed: ["npx vitest run"],
    limitations: ["spike: single real review only"],
    ...overrides
  };
}

describe("CODEX_VERDICT_OUTCOMES", () => {
  it("is exactly PASS, CHANGES_REQUESTED, BLOCKED -- no other outcome is ever valid", () => {
    expect(CODEX_VERDICT_OUTCOMES).toEqual(["PASS", "CHANGES_REQUESTED", "BLOCKED"]);
  });
});

describe("validateCodexVerdictPayload", () => {
  it("accepts a fully-populated, well-formed payload", () => {
    const result = validateCodexVerdictPayload(validPayload());
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("accepts a payload with populated findings carrying file/line/evidence", () => {
    const result = validateCodexVerdictPayload(
      validPayload({
        outcome: "CHANGES_REQUESTED",
        findings: [{ file: "src/foo.js", line: 42, evidence: "missing null check" }]
      })
    );
    expect(result.valid).toBe(true);
  });

  it("rejects a non-object payload (null, array, string, number)", () => {
    for (const bad of [null, [], "not an object", 42, undefined]) {
      const result = validateCodexVerdictPayload(bad);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("requires job.jobId, job.ticketId, job.sprintId as non-empty strings", () => {
    const missingJob = validateCodexVerdictPayload(validPayload({ job: undefined }));
    expect(missingJob.valid).toBe(false);
    expect(missingJob.errors.some((e) => e.includes("job"))).toBe(true);

    const emptyTicket = validateCodexVerdictPayload(
      validPayload({ job: { jobId: "job-1", ticketId: "", sprintId: "s" } })
    );
    expect(emptyTicket.valid).toBe(false);
    expect(emptyTicket.errors.some((e) => e.includes("ticketId"))).toBe(true);
  });

  it("requires reviewedSha to be a 40-character hex git SHA", () => {
    for (const bad of ["", "not-a-sha", "abc123", "g".repeat(40), "a".repeat(39)]) {
      const result = validateCodexVerdictPayload(validPayload({ reviewedSha: bad }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("reviewedSha"))).toBe(true);
    }
  });

  it("requires acceptanceCriteriaVersion to be a non-empty string", () => {
    const result = validateCodexVerdictPayload(validPayload({ acceptanceCriteriaVersion: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("acceptanceCriteriaVersion"))).toBe(true);
  });

  it("rejects an outcome outside PASS/CHANGES_REQUESTED/BLOCKED, including a lowercase or near-miss value", () => {
    for (const bad of ["pass", "FAIL", "PASSED", "", undefined, null]) {
      const result = validateCodexVerdictPayload(validPayload({ outcome: bad }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("outcome"))).toBe(true);
    }
  });

  it("requires findings to be an array", () => {
    const result = validateCodexVerdictPayload(validPayload({ findings: "none" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("findings"))).toBe(true);
  });

  it("requires each finding to carry file (string), line (integer), evidence (string)", () => {
    const result = validateCodexVerdictPayload(
      validPayload({ findings: [{ file: "x.js", line: "not-a-number", evidence: "" }] })
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("findings[0].line"))).toBe(true);
    expect(result.errors.some((e) => e.includes("findings[0].evidence"))).toBe(true);
  });

  it("requires checksPerformed to be an array of strings", () => {
    const result = validateCodexVerdictPayload(validPayload({ checksPerformed: [1, 2] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("checksPerformed"))).toBe(true);
  });

  it("requires limitations to be an array of strings", () => {
    const result = validateCodexVerdictPayload(validPayload({ limitations: null }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("limitations"))).toBe(true);
  });

  it("missing required field (no outcome key at all) is rejected -- never treated as a default/PASS", () => {
    const payload = validPayload();
    delete payload.outcome;
    const result = validateCodexVerdictPayload(payload);
    expect(result.valid).toBe(false);
  });

  it("accumulates every violation in one pass rather than stopping at the first", () => {
    const result = validateCodexVerdictPayload({ job: {}, findings: "x" });
    expect(result.errors.length).toBeGreaterThan(3);
  });
});
