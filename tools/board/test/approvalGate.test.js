import { describe, it, expect } from "vitest";
import {
  actorFromHeaders,
  approvalRecord,
  approvalVerdict,
  ApprovalRequiredError,
  assertRunnerMayApply,
  isAgentActor,
  isApprovalMarker,
  isApproved,
  isHumanActor,
  needsApproval,
  parkedForApprovalComment,
  requiresApproval,
  PARKED_STATUS,
  UNKNOWN_ACTOR
} from "../src/lib/approvalGate.js";

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

describe("requiresApproval / isApproved / needsApproval", () => {
  it("treats only an explicit true flag as gated", () => {
    expect(requiresApproval(task())).toBe(true);
    expect(requiresApproval(task({ requires_approval: false }))).toBe(false);
    expect(requiresApproval({ id: "T-0001" })).toBe(false);
    expect(requiresApproval(null)).toBe(false);
  });

  it("treats a recorded approver as the approval", () => {
    expect(isApproved(task())).toBe(false);
    expect(isApproved(task({ approved_by: "" }))).toBe(false);
    expect(isApproved(task({ approved_by: "DennieSeth" }))).toBe(true);
  });

  it("needs approval only while a gated card has none recorded", () => {
    expect(needsApproval(task())).toBe(true);
    expect(needsApproval(task({ approved_by: "DennieSeth" }))).toBe(false);
    expect(needsApproval(task({ requires_approval: false }))).toBe(false);
  });
});

/**
 * `approvalVerdict` (T-0286, docs/decision-log.md DL-27): the board record is the single,
 * authoritative answer to "is this asset/card approved?" -- built only from the fields this
 * module's own human gestures (AP-3/AP-4) ever write. Before this, `ASSET_PROVENANCE.md` kept
 * a second, hand-maintained mirror of the same verdict in prose, and nothing propagated one to
 * the other: T-0257 was approved on the board 2026-08-30 while its provenance row still read
 * "Not yet approved" for days, blocking T-0243/T-0244/T-0245/T-0246 on a decision already made
 * (PR #307 fixed that one row by hand). `approvalVerdict` is a pure read over `requiresApproval`
 * / `isApproved` -- it cannot write `approved_by`/`approved_at`, so it can only ever forward an
 * existing human stamp, never mint one.
 */
describe("approvalVerdict (T-0286, DL-27: single approval source of truth)", () => {
  it("passes trivially when the card is not gated", () => {
    const verdict = approvalVerdict(task({ requires_approval: false, approved_by: null }));
    expect(verdict).toEqual({
      taskId: "T-0257",
      requiresApproval: false,
      approved: true,
      approvedBy: null,
      approvedAt: null,
      reason: "card does not require a human direction approval"
    });
  });

  it("reports unapproved for a gated card with no recorded approval", () => {
    const verdict = approvalVerdict(task());
    expect(verdict.requiresApproval).toBe(true);
    expect(verdict.approved).toBe(false);
    expect(verdict.approvedBy).toBe(null);
    expect(verdict.approvedAt).toBe(null);
    expect(verdict.reason.toLowerCase()).toContain("no human approval");
  });

  it("reports approved for a gated card with a recorded human stamp", () => {
    const verdict = approvalVerdict(
      task({ approved_by: "@DennieSeth", approved_at: "2026-08-30T22:06:35.073Z" })
    );
    expect(verdict.approved).toBe(true);
    expect(verdict.approvedBy).toBe("@DennieSeth");
    expect(verdict.approvedAt).toBe("2026-08-30T22:06:35.073Z");
    expect(verdict.reason).toContain("@DennieSeth");
  });

  it(
    "reproduces the exact T-0243 drift scenario: the board record alone resolves T-0257 as " +
      "approved, regardless of what ASSET_PROVENANCE.md's prose says -- because this function " +
      "never reads that file at all",
    () => {
      // The real T-0257 board record (ASSET_PROVENANCE.md line ~110; PR #291).
      const t0257 = task({
        status: "done",
        approved_by: "Anonymous",
        approved_at: "2026-08-30T22:06:35.073Z"
      });

      const verdict = approvalVerdict(t0257);

      expect(verdict.approved).toBe(true);
      expect(verdict.approvedBy).toBe("Anonymous");
      expect(verdict.approvedAt).toBe("2026-08-30T22:06:35.073Z");
    }
  );

  it("never mints an approval -- an empty-string approved_by still fails, even when gated", () => {
    const verdict = approvalVerdict(task({ approved_by: "" }));
    expect(verdict.approved).toBe(false);
    expect(verdict.approvedBy).toBe(null);
  });
});

describe("actor identity", () => {
  it("classifies the wrapper's own stamp and every reserved agent identity as an agent", () => {
    for (const identity of [
      "agent",
      "AGENT",
      " agent ",
      "agent:assets",
      "assembled-board",
      "reviewer",
      "implementer",
      "planner",
      "assets",
      "generic",
      "system"
    ]) {
      expect(isAgentActor(identity), identity).toBe(true);
      expect(isHumanActor(identity), identity).toBe(false);
    }
  });

  it("classifies a person, the board UI, and an absent actor as human", () => {
    for (const identity of ["DennieSeth", "board-ui", "Anonymous", "", null, undefined]) {
      expect(isAgentActor(identity), String(identity)).toBe(false);
      expect(isHumanActor(identity), String(identity)).toBe(true);
    }
  });

  it("reads the actor off request headers, defaulting to unknown", () => {
    expect(actorFromHeaders({ "x-board-actor": "board-ui" })).toBe("board-ui");
    expect(actorFromHeaders({ "x-board-actor": ["agent", "board-ui"] })).toBe("agent");
    expect(actorFromHeaders({ "x-board-actor": "  " })).toBe(UNKNOWN_ACTOR);
    expect(actorFromHeaders({})).toBe(UNKNOWN_ACTOR);
    expect(actorFromHeaders()).toBe(UNKNOWN_ACTOR);
  });
});

describe("isApprovalMarker", () => {
  it("accepts the marker as the first non-empty line, in any case, with a rationale below", () => {
    expect(isApprovalMarker("APPROVED")).toBe(true);
    expect(isApprovalMarker("approved")).toBe(true);
    expect(isApprovalMarker("  Approved  ")).toBe(true);
    expect(isApprovalMarker("/approve")).toBe(true);
    expect(isApprovalMarker("/APPROVE")).toBe(true);
    expect(isApprovalMarker("\n\nAPPROVED\n\nReads as one vocabulary with v1 -- ship it.")).toBe(true);
    expect(isApprovalMarker("APPROVED\r\nlooks great")).toBe(true);
  });

  it("rejects a comment that merely discusses approval", () => {
    // The exact shapes the "first line, exactly" rule exists to reject -- a loose
    // substring match would read every one of these as an approval.
    expect(isApprovalMarker("not approved yet -- the props read as synthetic")).toBe(false);
    expect(isApprovalMarker("the sheet says APPROVED in the corner")).toBe(false);
    expect(isApprovalMarker("Looks good to me!\nAPPROVED")).toBe(false);
    expect(isApprovalMarker("approved?")).toBe(false);
    expect(isApprovalMarker("APPROVED_BY_NOBODY")).toBe(false);
    expect(isApprovalMarker("")).toBe(false);
    expect(isApprovalMarker("   \n  ")).toBe(false);
    expect(isApprovalMarker(null)).toBe(false);
    expect(isApprovalMarker(42)).toBe(false);
  });
});

describe("approvalRecord", () => {
  it("records who approved and when", () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    expect(approvalRecord({ actor: "DennieSeth", now })).toEqual({
      approved_by: "DennieSeth",
      approved_at: "2026-08-30T12:00:00.000Z"
    });
  });

  it("never records an empty approver", () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    expect(approvalRecord({ actor: "   ", now }).approved_by).toBe(UNKNOWN_ACTOR);
    expect(approvalRecord({ now }).approved_by).toBe(UNKNOWN_ACTOR);
  });
});

describe("assertRunnerMayApply", () => {
  it("refuses to let an automated write complete an unapproved gated card", () => {
    expect(() => assertRunnerMayApply(task(), { status: "done" })).toThrow(ApprovalRequiredError);
    expect(() => assertRunnerMayApply(task(), { status: "done" })).toThrow(/human direction approval/i);
  });

  it("allows every other write on a gated card, including parking it", () => {
    expect(() => assertRunnerMayApply(task(), { status: PARKED_STATUS })).not.toThrow();
    expect(() => assertRunnerMayApply(task(), { status: "blocked" })).not.toThrow();
    expect(() => assertRunnerMayApply(task(), { attempts: 3 })).not.toThrow();
    expect(() => assertRunnerMayApply(task(), {})).not.toThrow();
    expect(() => assertRunnerMayApply(task(), null)).not.toThrow();
  });

  it("allows done on a card that is not gated, or that a human already approved", () => {
    expect(() => assertRunnerMayApply(task({ requires_approval: false }), { status: "done" })).not.toThrow();
    expect(() => assertRunnerMayApply(task({ approved_by: "DennieSeth" }), { status: "done" })).not.toThrow();
  });
});

describe("parkedForApprovalComment", () => {
  it("names the card and both exits, so a human never has to go looking for the ritual", () => {
    const text = parkedForApprovalComment("T-0257");
    expect(text).toMatch(/PARKED FOR HUMAN APPROVAL/);
    expect(text).toMatch(/move this card to Done/i);
    expect(text).toMatch(/APPROVED/);
    expect(text).toMatch(/re-run/i);
    expect(text).toContain("T-0257");
  });

  it("is not itself an approval marker -- the board's own notice must never approve anything", () => {
    expect(isApprovalMarker(parkedForApprovalComment("T-0257"))).toBe(false);
  });
});
