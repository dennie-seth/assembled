import { describe, it, expect, vi } from "vitest";
import { regenerateApprovalLedgerIfChanged, APPROVAL_LEDGER_RELATIVE_PATH } from "../../src/runner/approvalLedgerRegen.js";

/**
 * T-0313: the ledger regeneration step folded into `_handlePass` (runOrchestrator.js), right
 * before a PASS's branch is pushed. See its own docstring for why every card's branch gets this,
 * not only ones touching ASSET_PROVENANCE.md, and why the merge-conflict rule for this generated
 * file is "regenerate again", never a hand-resolved JSON diff.
 */

const NOW = new Date("2026-09-06T12:00:00.000Z");

function ledgerFile(cards, generated_at = "2026-09-01T00:00:00.000Z") {
  return { version: 1, generated_at, cards };
}

describe("regenerateApprovalLedgerIfChanged", () => {
  it("writes a fresh ledger when the live store's approval state differs from the committed file", async () => {
    const existing = ledgerFile([{ id: "T-0273", requires_approval: true, approved_by: null, approved_at: null }]);
    const readLedgerFn = vi.fn(async () => existing);
    const writeFileFn = vi.fn(async () => {});

    const result = await regenerateApprovalLedgerIfChanged({
      worktreeDir: "/repo/worktrees/T-9999",
      tasks: [
        { id: "T-0273", requires_approval: true, approved_by: "DennieSeth", approved_at: "2026-09-03T17:52:21.435Z" }
      ],
      now: () => NOW,
      readLedgerFn,
      writeFileFn
    });

    expect(result.changed).toBe(true);
    expect(writeFileFn).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContent] = writeFileFn.mock.calls[0];
    expect(writtenPath).toBe(`/repo/worktrees/T-9999/${APPROVAL_LEDGER_RELATIVE_PATH}`);
    const parsed = JSON.parse(writtenContent);
    expect(parsed.cards).toEqual([
      { id: "T-0273", requires_approval: true, approved_by: "DennieSeth", approved_at: "2026-09-03T17:52:21.435Z" }
    ]);
    expect(parsed.generated_at).toBe(NOW.toISOString());
  });

  it("writes nothing and reports unchanged when the regenerated cards are byte-identical to the committed ledger", async () => {
    const cards = [{ id: "T-0100", requires_approval: false, approved_by: null, approved_at: null }];
    const readLedgerFn = vi.fn(async () => ledgerFile(cards));
    const writeFileFn = vi.fn(async () => {});

    const result = await regenerateApprovalLedgerIfChanged({
      worktreeDir: "/repo/worktrees/T-9999",
      tasks: [{ id: "T-0100", requires_approval: false, approved_by: null, approved_at: null }],
      now: () => NOW,
      readLedgerFn,
      writeFileFn
    });

    expect(result.changed).toBe(false);
    expect(writeFileFn).not.toHaveBeenCalled();
  });

  it("ignores a generated_at-only difference -- unrelated PRs must not pick up ledger noise", async () => {
    // Same cards, older generated_at -- this is the case that matters: without excluding
    // generated_at from the comparison, every single PASS would "change" the file.
    const cards = [{ id: "T-0100", requires_approval: false, approved_by: null, approved_at: null }];
    const readLedgerFn = vi.fn(async () => ledgerFile(cards, "2020-01-01T00:00:00.000Z"));
    const writeFileFn = vi.fn(async () => {});

    const result = await regenerateApprovalLedgerIfChanged({
      worktreeDir: "/repo/worktrees/T-9999",
      tasks: [{ id: "T-0100", requires_approval: false, approved_by: null, approved_at: null }],
      now: () => NOW,
      readLedgerFn,
      writeFileFn
    });

    expect(result.changed).toBe(false);
    expect(writeFileFn).not.toHaveBeenCalled();
  });

  it("writes a ledger when none is committed yet", async () => {
    const readLedgerFn = vi.fn(async () => null);
    const writeFileFn = vi.fn(async () => {});

    const result = await regenerateApprovalLedgerIfChanged({
      worktreeDir: "/repo/worktrees/T-9999",
      tasks: [{ id: "T-0001", requires_approval: false }],
      now: () => NOW,
      readLedgerFn,
      writeFileFn
    });

    expect(result.changed).toBe(true);
    expect(writeFileFn).toHaveBeenCalledTimes(1);
  });

  it("propagates a write failure instead of swallowing it -- the caller decides how to handle it", async () => {
    const readLedgerFn = vi.fn(async () => null);
    const writeFileFn = vi.fn(async () => {
      throw new Error("ENOSPC: no space left on device");
    });

    await expect(
      regenerateApprovalLedgerIfChanged({
        worktreeDir: "/repo/worktrees/T-9999",
        tasks: [{ id: "T-0001", requires_approval: false }],
        now: () => NOW,
        readLedgerFn,
        writeFileFn
      })
    ).rejects.toThrow(/ENOSPC/);
  });
});
