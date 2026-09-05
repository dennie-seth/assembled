import { describe, it, expect, vi } from "vitest";
import { checkApproval, DEFAULT_FRESHNESS_BUDGET_MS } from "../src/lib/approvalCheck.js";

/**
 * T-0307: five T-0274 runs were burned because a "blocker report" read
 * `tools/board/approval-ledger.json` -- a generated snapshot -- as authoritative, and fired
 * fail-closed against a gate a human had lifted nearly five hours after the ledger was generated.
 * `checkApproval` is the fix: the live board is consulted before any fail-closed gate fires, and
 * the ledger's own authority is bounded by how old it is.
 */

const NOW = new Date("2026-09-03T18:00:00.000Z");
const STALE_GENERATED_AT = "2026-09-03T13:00:22.804Z"; // the real T-0273 ledger's generated_at
const FRESH_GENERATED_AT = "2026-09-03T17:59:50.000Z"; // 10s before NOW, well inside the budget

function ledgerWith(entries, generatedAt = STALE_GENERATED_AT) {
  return { version: 1, generated_at: generatedAt, cards: entries };
}

function fakeLedgerReader(ledger) {
  return async () => ledger;
}

function fakeApiResponse(body, status = 200) {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body
  });
}

function boardVerdict({ taskId, requiresApproval, approved, approvedBy = null, approvedAt = null, reason = "" }) {
  return { taskId, requiresApproval, approved, approvedBy, approvedAt, reason };
}

const BASE_OPTS = { taskId: "T-0273", ledgerPath: "/fake/approval-ledger.json", now: () => NOW };

describe("checkApproval: the live board wins over a stale ledger (the T-0273 shape)", () => {
  it("passes when the live board reports approved, even though the stale ledger says approved_by: null", async () => {
    const readLedgerFn = fakeLedgerReader(
      ledgerWith([{ id: "T-0273", requires_approval: true, approved_by: null, approved_at: null }])
    );
    const fetchFn = vi.fn(
      fakeApiResponse(
        boardVerdict({
          taskId: "T-0273",
          requiresApproval: true,
          approved: true,
          approvedBy: "@DennieSeth",
          approvedAt: "2026-09-03T17:52:21.435Z"
        })
      )
    );

    const verdict = await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn });

    expect(verdict.approved).toBe(true);
    expect(verdict.requiresApproval).toBe(true);
    expect(verdict.approvedBy).toBe("@DennieSeth");
    expect(verdict.source).toBe("board-api");
    // The ledger being stale is exactly why the live board had to be consulted at all.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a ledger snapshot older than the freshness budget is not, on its own, sufficient to fail a gate", async () => {
    const readLedgerFn = fakeLedgerReader(
      ledgerWith([{ id: "T-0273", requires_approval: true, approved_by: null, approved_at: null }])
    );
    const fetchFn = vi.fn(fakeApiResponse(boardVerdict({ taskId: "T-0273", requiresApproval: true, approved: true })));

    await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("still fails closed when the live board genuinely reports the card as not approved", async () => {
    const readLedgerFn = fakeLedgerReader(
      ledgerWith([{ id: "T-0273", requires_approval: true, approved_by: null, approved_at: null }])
    );
    const fetchFn = vi.fn(
      fakeApiResponse(boardVerdict({ taskId: "T-0273", requiresApproval: true, approved: false }))
    );

    const verdict = await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn });

    expect(verdict.approved).toBe(false);
    expect(verdict.requiresApproval).toBe(true);
    expect(verdict.source).toBe("board-api");
    expect(verdict.verified).toBe(true);
  });

  it("the board wins even over a STALE ledger that claims approval -- a revoked approval must not slip through", async () => {
    const readLedgerFn = fakeLedgerReader(
      ledgerWith([
        { id: "T-0273", requires_approval: true, approved_by: "@DennieSeth", approved_at: "2026-09-03T10:00:00.000Z" }
      ])
    );
    const fetchFn = vi.fn(
      fakeApiResponse(boardVerdict({ taskId: "T-0273", requiresApproval: true, approved: false }))
    );

    const verdict = await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn });

    expect(verdict.approved).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("checkApproval: a fresh ledger may be used without an unnecessary API call", () => {
  it("resolves straight from the ledger when it is within the freshness budget, and never calls the board", async () => {
    const readLedgerFn = fakeLedgerReader(
      ledgerWith(
        [{ id: "T-0273", requires_approval: true, approved_by: "@DennieSeth", approved_at: "2026-09-03T17:59:00.000Z" }],
        FRESH_GENERATED_AT
      )
    );
    const fetchFn = vi.fn(async () => {
      throw new Error("must not be called for a fresh ledger");
    });

    const verdict = await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(verdict.approved).toBe(true);
    expect(verdict.source).toBe("ledger");
    expect(verdict.verified).toBe(true);
    expect(verdict.generatedAt).toBe(FRESH_GENERATED_AT);
    expect(verdict.ageMs).toBeLessThanOrEqual(DEFAULT_FRESHNESS_BUDGET_MS);
  });

  it("the T-0273 shape compressed: a fresh ledger's null answer is trusted even if approval landed moments " +
    "later -- the residual race window the freshness budget deliberately accepts, narrowed from days to minutes", async () => {
    const readLedgerFn = fakeLedgerReader(
      ledgerWith([{ id: "T-0273", requires_approval: true, approved_by: null, approved_at: null }], FRESH_GENERATED_AT)
    );
    const fetchFn = vi.fn(async () => {
      throw new Error("must not be called for a fresh ledger");
    });

    const verdict = await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(verdict.approved).toBe(false);
    expect(verdict.requiresApproval).toBe(true);
  });

  it("a card with requires_approval: false in the ledger is a no-op -- no API call regardless of ledger age", async () => {
    const readLedgerFn = fakeLedgerReader(
      ledgerWith([{ id: "T-0273", requires_approval: false, approved_by: null, approved_at: null }])
    );
    const fetchFn = vi.fn(async () => {
      throw new Error("must not be called for a non-gated card");
    });

    const verdict = await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(verdict.requiresApproval).toBe(false);
    expect(verdict.approved).toBe(true);
    expect(verdict.source).toBe("ledger");
  });
});

describe("checkApproval: an unreachable board fails closed, distinguishably from a verified refusal", () => {
  it("fails closed when the board request throws, and marks the verdict as unverified", async () => {
    const readLedgerFn = fakeLedgerReader(
      ledgerWith([{ id: "T-0273", requires_approval: true, approved_by: null, approved_at: null }])
    );
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const verdict = await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn });

    expect(verdict.approved).toBe(false);
    expect(verdict.requiresApproval).toBe(true);
    expect(verdict.source).toBe("board-unreachable");
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toMatch(/ECONNREFUSED/);
  });

  it("is distinguishable from a live board's genuine not-approved verdict", async () => {
    const readLedgerFn = fakeLedgerReader(null);

    const unreachable = await checkApproval({
      ...BASE_OPTS,
      readLedgerFn,
      fetchFn: vi.fn(async () => {
        throw new Error("timed out");
      })
    });
    const genuinelyUnapproved = await checkApproval({
      ...BASE_OPTS,
      readLedgerFn,
      fetchFn: vi.fn(fakeApiResponse(boardVerdict({ taskId: "T-0273", requiresApproval: true, approved: false })))
    });

    expect(unreachable.approved).toBe(false);
    expect(genuinelyUnapproved.approved).toBe(false);
    expect(unreachable.verified).toBe(false);
    expect(genuinelyUnapproved.verified).toBe(true);
    expect(unreachable.source).not.toBe(genuinelyUnapproved.source);
  });

  it("fails closed distinguishably on a 404 (deleted/renumbered card), not the same reason as unreachable", async () => {
    const readLedgerFn = fakeLedgerReader(null);
    const fetchFn = vi.fn(fakeApiResponse({}, 404));

    const verdict = await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn });

    expect(verdict.approved).toBe(false);
    expect(verdict.verified).toBe(false);
    expect(verdict.source).toBe("board-404");
    expect(verdict.reason).toMatch(/404|deleted|renumbered/i);
  });

  it("fails closed on a non-404 error status from the board", async () => {
    const readLedgerFn = fakeLedgerReader(null);
    const fetchFn = vi.fn(fakeApiResponse({}, 500));

    const verdict = await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn });

    expect(verdict.approved).toBe(false);
    expect(verdict.verified).toBe(false);
    expect(verdict.source).toBe("board-error");
  });
});

describe("checkApproval: ledger edge cases fall through to the live board rather than crashing", () => {
  it("a missing ledger (readLedgerFn resolves null) consults the board directly", async () => {
    const readLedgerFn = fakeLedgerReader(null);
    const fetchFn = vi.fn(fakeApiResponse(boardVerdict({ taskId: "T-0273", requiresApproval: true, approved: true })));

    const verdict = await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(verdict.approved).toBe(true);
  });

  it("a malformed ledger (readLedgerFn throws) consults the board directly instead of crashing", async () => {
    const readLedgerFn = async () => {
      throw new SyntaxError("Unexpected token in JSON");
    };
    const fetchFn = vi.fn(fakeApiResponse(boardVerdict({ taskId: "T-0273", requiresApproval: true, approved: true })));

    const verdict = await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(verdict.approved).toBe(true);
  });

  it("an empty ledger (no cards for this id) consults the board directly", async () => {
    const readLedgerFn = fakeLedgerReader(ledgerWith([], FRESH_GENERATED_AT));
    const fetchFn = vi.fn(fakeApiResponse(boardVerdict({ taskId: "T-0273", requiresApproval: true, approved: true })));

    const verdict = await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(verdict.approved).toBe(true);
  });

  it("clock skew (generated_at in the future) does not crash, and the ledger reads as fresh", async () => {
    const futureGeneratedAt = "2026-09-03T19:00:00.000Z"; // an hour after NOW
    const readLedgerFn = fakeLedgerReader(
      ledgerWith(
        [{ id: "T-0273", requires_approval: true, approved_by: "@DennieSeth", approved_at: "x" }],
        futureGeneratedAt
      )
    );
    const fetchFn = vi.fn(async () => {
      throw new Error("must not be called");
    });

    const verdict = await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(verdict.approved).toBe(true);
  });
});

describe("checkApproval: every gate refusal logs its source, generated_at, and age", () => {
  it("logs when the live board reports not-approved", async () => {
    const log = vi.fn();
    const readLedgerFn = fakeLedgerReader(ledgerWith([{ id: "T-0273", requires_approval: true, approved_by: null, approved_at: null }]));
    const fetchFn = vi.fn(fakeApiResponse(boardVerdict({ taskId: "T-0273", requiresApproval: true, approved: false })));

    await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn, log });

    expect(log).toHaveBeenCalledTimes(1);
    const [message] = log.mock.calls[0];
    expect(message).toContain("T-0273");
    expect(message).toContain("board-api");
  });

  it("logs when the board is unreachable, including the source and ledger age", async () => {
    const log = vi.fn();
    const readLedgerFn = fakeLedgerReader(ledgerWith([{ id: "T-0273", requires_approval: true, approved_by: null, approved_at: null }]));
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn, log });

    expect(log).toHaveBeenCalledTimes(1);
    const [message] = log.mock.calls[0];
    expect(message).toContain("board-unreachable");
    expect(message).toMatch(/generated_at/i);
    expect(message).toMatch(/age/i);
  });

  it("does NOT log when the card is approved", async () => {
    const log = vi.fn();
    const readLedgerFn = fakeLedgerReader(ledgerWith([{ id: "T-0273", requires_approval: true, approved_by: null, approved_at: null }]));
    const fetchFn = vi.fn(fakeApiResponse(boardVerdict({ taskId: "T-0273", requiresApproval: true, approved: true })));

    await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn, log });

    expect(log).not.toHaveBeenCalled();
  });

  it("does NOT log for a no-op (card that does not require approval)", async () => {
    const log = vi.fn();
    const readLedgerFn = fakeLedgerReader(ledgerWith([{ id: "T-0273", requires_approval: false, approved_by: null, approved_at: null }]));
    const fetchFn = vi.fn(async () => {
      throw new Error("must not be called");
    });

    await checkApproval({ ...BASE_OPTS, readLedgerFn, fetchFn, log });

    expect(log).not.toHaveBeenCalled();
  });
});
