import { describe, it, expect } from "vitest";
import { findApprovalDrift } from "../src/lib/approvalProvenanceDrift.js";

/**
 * `findApprovalDrift` (T-0286, docs/decision-log.md DL-27): the mechanical backstop for the
 * T-0257/T-0243 incident. Option A made the board record the single source of truth for
 * "is this approved?" (`approvalGate.js`'s `approvalVerdict`) -- but nothing yet stops
 * `ASSET_PROVENANCE.md`'s human-readable prose from sitting stale for days the way it did for
 * T-0257 (approved on the board 2026-08-30, provenance row still read "Not yet approved," which
 * blocked T-0243/T-0244/T-0245/T-0246 on a decision already made). This function never *resolves*
 * approval from the prose -- that would reintroduce the very thing Option A rejected -- it only
 * flags a provenance row whose own claim contradicts the board's real verdict, so the drift is
 * caught by CI instead of by a human noticing days later.
 */

function task(overrides = {}) {
  return {
    id: "T-0257",
    status: "review",
    requires_approval: true,
    approved_by: null,
    approved_at: null,
    ...overrides
  };
}

describe("findApprovalDrift", () => {
  it(
    "reproduces the exact T-0243 drift scenario: a stale 'not yet approved' provenance row " +
      "for a card the board already approved is flagged as drift",
    () => {
      const provenanceText =
        "| `assets/src/concept/signal_tower_props_concept_sheet_v3.png` (T-0257 — replaces the " +
        "declined v2 sheet as the four blocked room cards' approval gate) | ... This card parks " +
        "for human direction approval per §23-h's pattern -- not yet approved. | MIT | ... | seed=1 |";

      const t0257 = task({
        status: "done",
        approved_by: "Anonymous",
        approved_at: "2026-08-30T22:06:35.073Z"
      });

      const report = findApprovalDrift({ provenanceText, tasks: [t0257] });

      expect(report.ok).toBe(false);
      expect(report.drifts).toHaveLength(1);
      expect(report.drifts[0]).toMatchObject({ taskId: "T-0257", kind: "stale-unapproved-claim" });
      expect(report.drifts[0].message).toContain("T-0257");
      expect(report.drifts[0].message.toLowerCase()).toContain("board");
    }
  );

  it("reports clean once the provenance row has been refreshed to match the board (post PR #307)", () => {
    const provenanceText =
      "| `assets/src/concept/signal_tower_props_concept_sheet_v3.png` (T-0257 -- **APPROVED " +
      "2026-08-30** -- direction verdict recorded on the board) | ... | MIT | ... | seed=1 |";

    const t0257 = task({
      status: "done",
      approved_by: "Anonymous",
      approved_at: "2026-08-30T22:06:35.073Z"
    });

    const report = findApprovalDrift({ provenanceText, tasks: [t0257] });

    expect(report.ok).toBe(true);
    expect(report.drifts).toEqual([]);
  });

  it("flags the opposite drift: prose claims APPROVED but the board has no recorded approval", () => {
    const provenanceText =
      "| `assets/final/props/example_v1.png` (T-0999 -- **APPROVED 2026-08-30**) | ... | MIT | ... | seed=1 |";

    const t0999 = task({ id: "T-0999" }); // requires_approval: true, no approved_by/approved_at

    const report = findApprovalDrift({ provenanceText, tasks: [t0999] });

    expect(report.ok).toBe(false);
    expect(report.drifts).toHaveLength(1);
    expect(report.drifts[0]).toMatchObject({ taskId: "T-0999", kind: "unsubstantiated-approved-claim" });
  });

  it("does not flag a genuinely-unapproved, non-gated, or unknown card", () => {
    const provenanceText =
      "| a (T-0239 -- not yet approved) | ... |\n" +
      "| b (T-1234 -- not yet approved) | ... |";

    const declined = task({ id: "T-0239", requires_approval: true }); // still correctly unapproved
    const notGated = task({ id: "T-1234", requires_approval: false, approved_by: null });

    const report = findApprovalDrift({ provenanceText, tasks: [declined, notGated] });

    expect(report.ok).toBe(true);
    expect(report.drifts).toEqual([]);
  });

  it("ignores lines that mention a task id but say nothing about approval", () => {
    const provenanceText = "| some row referencing (T-0257 -- Power Substation) with no approval prose | ... |";
    const t0257 = task({ approved_by: "Anonymous", approved_at: "2026-08-30T22:06:35.073Z" });

    const report = findApprovalDrift({ provenanceText, tasks: [t0257] });

    expect(report.ok).toBe(true);
  });

  it("is a pure read -- never mints or alters an approval record, only reports", () => {
    const provenanceText = "not yet approved (T-0257)";
    const t0257 = task({ approved_by: "Anonymous", approved_at: "2026-08-30T22:06:35.073Z" });
    const frozen = Object.freeze({ ...t0257 });

    expect(() => findApprovalDrift({ provenanceText, tasks: [frozen] })).not.toThrow();
  });
});
