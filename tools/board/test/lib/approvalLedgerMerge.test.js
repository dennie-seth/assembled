import { describe, it, expect } from "vitest";
import { mergeApprovalLedgerJson } from "../../src/lib/approvalLedgerMerge.js";

/**
 * T-0464: `tools/board/approval-ledger.json` is regenerated on every PASS and on a 4h schedule,
 * so both sides of nearly every merge touch it -- git's default 3-way text merge treats that as a
 * content conflict every time, even though the "right" answer is almost always just "keep every
 * card id from both sides, and don't go backwards on generated_at." This is the pure merge
 * function the git merge driver (mergeApprovalLedgerDriver.js) wraps -- see that file's own test
 * for the end-to-end, real-git-repo proof.
 */

function ledger({ generatedAt, cards }) {
  return JSON.stringify({ version: 1, generated_at: generatedAt, cards });
}

function card(id, overrides = {}) {
  return { id, requires_approval: false, approved_by: null, approved_at: null, ...overrides };
}

describe("mergeApprovalLedgerJson", () => {
  it("unions card ids that only exist on one side -- no id from either parent is dropped", () => {
    const baseText = ledger({ generatedAt: "2026-10-21T10:00:00.000Z", cards: [card("T-0001")] });
    const oursText = ledger({
      generatedAt: "2026-10-21T12:00:00.000Z",
      cards: [card("T-0001"), card("T-0002")]
    });
    const theirsText = ledger({
      generatedAt: "2026-10-21T11:00:00.000Z",
      cards: [card("T-0001"), card("T-0003")]
    });

    const result = mergeApprovalLedgerJson({ baseText, oursText, theirsText });

    expect(result.ok).toBe(true);
    const ids = result.merged.cards.map((c) => c.id);
    expect(ids).toEqual(["T-0001", "T-0002", "T-0003"]);
  });

  it("survives both changes when one side adds a new card and the other flips an existing card's requires_approval", () => {
    const baseText = ledger({
      generatedAt: "2026-10-21T10:00:00.000Z",
      cards: [card("T-0001", { requires_approval: false })]
    });
    const oursText = ledger({
      generatedAt: "2026-10-21T12:00:00.000Z",
      cards: [card("T-0001", { requires_approval: false }), card("T-0099")]
    });
    const theirsText = ledger({
      generatedAt: "2026-10-21T11:00:00.000Z",
      cards: [card("T-0001", { requires_approval: true, approved_by: "Anonymous", approved_at: "2026-10-21T11:00:00.000Z" })]
    });

    const result = mergeApprovalLedgerJson({ baseText, oursText, theirsText });

    expect(result.ok).toBe(true);
    const byId = Object.fromEntries(result.merged.cards.map((c) => [c.id, c]));
    expect(byId["T-0099"]).toBeTruthy();
    expect(byId["T-0001"].requires_approval).toBe(true);
    expect(byId["T-0001"].approved_by).toBe("Anonymous");
  });

  it("picks the later of the two generated_at values, never older than either side", () => {
    const baseText = ledger({ generatedAt: "2026-10-21T09:00:00.000Z", cards: [card("T-0001")] });
    const oursText = ledger({ generatedAt: "2026-10-21T12:00:00.000Z", cards: [card("T-0001")] });
    const theirsText = ledger({ generatedAt: "2026-10-21T18:02:14.924Z", cards: [card("T-0001")] });

    const result = mergeApprovalLedgerJson({ baseText, oursText, theirsText });

    expect(result.ok).toBe(true);
    expect(result.merged.generated_at).toBe("2026-10-21T18:02:14.924Z");
  });

  it("is deterministic when both sides carry an identical generated_at", () => {
    const sameTimestamp = "2026-10-21T14:00:00.000Z";
    const baseText = ledger({ generatedAt: "2026-10-21T09:00:00.000Z", cards: [card("T-0001")] });
    const oursText = ledger({ generatedAt: sameTimestamp, cards: [card("T-0001")] });
    const theirsText = ledger({ generatedAt: sameTimestamp, cards: [card("T-0001")] });

    const first = mergeApprovalLedgerJson({ baseText, oursText, theirsText });
    const second = mergeApprovalLedgerJson({ baseText, oursText, theirsText });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.merged.generated_at).toBe(sameTimestamp);
    expect(second.merged.generated_at).toBe(sameTimestamp);
  });

  it("conflicts rather than guessing when both sides change the same field on the same card to different values", () => {
    const baseText = ledger({
      generatedAt: "2026-10-21T09:00:00.000Z",
      cards: [card("T-0001", { approved_by: null })]
    });
    const oursText = ledger({
      generatedAt: "2026-10-21T12:00:00.000Z",
      cards: [card("T-0001", { requires_approval: true, approved_by: "Alice" })]
    });
    const theirsText = ledger({
      generatedAt: "2026-10-21T11:00:00.000Z",
      cards: [card("T-0001", { requires_approval: true, approved_by: "Bob" })]
    });

    const result = mergeApprovalLedgerJson({ baseText, oursText, theirsText });

    expect(result.ok).toBe(false);
  });

  it("conflicts on truncated/unparseable JSON on either side instead of silently dropping records", () => {
    const baseText = ledger({ generatedAt: "2026-10-21T09:00:00.000Z", cards: [card("T-0001")] });
    const oursText = ledger({ generatedAt: "2026-10-21T12:00:00.000Z", cards: [card("T-0001"), card("T-0002")] });
    const theirsTruncated = '{"version": 1, "generated_at": "2026-10-21T11:00:00.000Z", "cards": [{"id": "T-00';

    const result = mergeApprovalLedgerJson({ baseText, oursText, theirsText: theirsTruncated });

    expect(result.ok).toBe(false);
  });

  it("conflicts when either side's cards array is empty, rather than emitting a ledger that drops every record", () => {
    const baseText = ledger({ generatedAt: "2026-10-21T09:00:00.000Z", cards: [card("T-0001")] });
    const oursText = ledger({ generatedAt: "2026-10-21T12:00:00.000Z", cards: [] });
    const theirsText = ledger({ generatedAt: "2026-10-21T11:00:00.000Z", cards: [card("T-0001"), card("T-0002")] });

    const result = mergeApprovalLedgerJson({ baseText, oursText, theirsText });

    expect(result.ok).toBe(false);
  });

  it("conflicts when a side is missing the cards array entirely", () => {
    const baseText = ledger({ generatedAt: "2026-10-21T09:00:00.000Z", cards: [card("T-0001")] });
    const oursText = JSON.stringify({ version: 1, generated_at: "2026-10-21T12:00:00.000Z" });
    const theirsText = ledger({ generatedAt: "2026-10-21T11:00:00.000Z", cards: [card("T-0001")] });

    const result = mergeApprovalLedgerJson({ baseText, oursText, theirsText });

    expect(result.ok).toBe(false);
  });

  it("tolerates a missing/empty base (e.g. the file didn't exist at the merge-base) by merging on ours/theirs alone", () => {
    const oursText = ledger({ generatedAt: "2026-10-21T12:00:00.000Z", cards: [card("T-0001")] });
    const theirsText = ledger({ generatedAt: "2026-10-21T11:00:00.000Z", cards: [card("T-0002")] });

    const result = mergeApprovalLedgerJson({ baseText: "", oursText, theirsText });

    expect(result.ok).toBe(true);
    expect(result.merged.cards.map((c) => c.id)).toEqual(["T-0001", "T-0002"]);
  });

  it("produces output that round-trips as valid JSON with a cards array", () => {
    const baseText = ledger({ generatedAt: "2026-10-21T09:00:00.000Z", cards: [card("T-0001")] });
    const oursText = ledger({ generatedAt: "2026-10-21T12:00:00.000Z", cards: [card("T-0001")] });
    const theirsText = ledger({ generatedAt: "2026-10-21T11:00:00.000Z", cards: [card("T-0002")] });

    const result = mergeApprovalLedgerJson({ baseText, oursText, theirsText });

    expect(result.ok).toBe(true);
    const reparsed = JSON.parse(JSON.stringify(result.merged));
    expect(Array.isArray(reparsed.cards)).toBe(true);
  });
});
