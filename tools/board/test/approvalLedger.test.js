import { describe, it, expect } from "vitest";
import {
  buildApprovalLedger,
  readApprovalLedger,
  ledgerAgeDays,
  mergeTasksWithLedger,
  LEDGER_VERSION
} from "../src/lib/approvalLedger.js";
import { findApprovalDrift } from "../src/lib/approvalProvenanceDrift.js";

const NOW = new Date("2026-09-03T12:00:00.000Z");

describe("buildApprovalLedger", () => {
  it("projects tasks down to the four approval fields only", () => {
    const l = buildApprovalLedger(
      [{ id: "T-0257", title: "big body", body: "x".repeat(50000), status: "done", requires_approval: true, approved_by: "Anonymous", approved_at: "2026-08-30T22:06:35.073Z" }],
      { now: () => NOW }
    );
    expect(l.version).toBe(LEDGER_VERSION);
    expect(l.cards).toHaveLength(1);
    expect(Object.keys(l.cards[0]).sort()).toEqual(["approved_at", "approved_by", "id", "requires_approval"]);
    // a ledger is an approval record, not a task mirror -- bodies must never ride along
    expect(JSON.stringify(l)).not.toContain("xxxxx");
  });

  it("sorts by id so the committed file has a stable diff", () => {
    const l = buildApprovalLedger([{ id: "T-0257" }, { id: "T-0220" }, { id: "T-0243" }], { now: () => NOW });
    expect(l.cards.map((c) => c.id)).toEqual(["T-0220", "T-0243", "T-0257"]);
  });

  it("normalises a non-gated card to requires_approval false with null stamps", () => {
    const l = buildApprovalLedger([{ id: "T-0220", status: "done" }], { now: () => NOW });
    expect(l.cards[0]).toEqual({ id: "T-0220", requires_approval: false, approved_by: null, approved_at: null });
  });
});

describe("readApprovalLedger", () => {
  it("returns null when the ledger is absent rather than throwing", async () => {
    const enoent = Object.assign(new Error("nope"), { code: "ENOENT" });
    const r = await readApprovalLedger("/nope.json", { readFileFn: async () => { throw enoent; } });
    expect(r).toBeNull();
  });

  it("rejects a file that is not a ledger", async () => {
    await expect(
      readApprovalLedger("/bad.json", { readFileFn: async () => JSON.stringify({ nope: true }) })
    ).rejects.toThrow(/not a valid approval ledger/);
  });
});

describe("ledgerAgeDays", () => {
  it("reports age in days", () => {
    const l = { generated_at: "2026-09-01T12:00:00.000Z" };
    expect(ledgerAgeDays(l, { now: () => NOW })).toBeCloseTo(2, 5);
  });

  it("treats a missing or unparseable timestamp as infinitely stale", () => {
    expect(ledgerAgeDays({}, { now: () => NOW })).toBe(Infinity);
    expect(ledgerAgeDays({ generated_at: "not-a-date" }, { now: () => NOW })).toBe(Infinity);
  });
});

describe("mergeTasksWithLedger", () => {
  it("fills in only ids the live store could not resolve", () => {
    const { tasks, filledFromLedger } = mergeTasksWithLedger(
      [{ id: "T-0100", requires_approval: false }],
      { cards: [{ id: "T-0257", requires_approval: true, approved_by: "Anonymous", approved_at: "x" }] }
    );
    expect(filledFromLedger).toBe(1);
    expect(tasks.map((t) => t.id).sort()).toEqual(["T-0100", "T-0257"]);
  });

  it("never lets the ledger override a live task -- the board stays authoritative", () => {
    const live = { id: "T-0257", requires_approval: true, approved_by: "RealHuman", approved_at: "live" };
    const { tasks, filledFromLedger } = mergeTasksWithLedger([live], {
      cards: [{ id: "T-0257", requires_approval: true, approved_by: "StaleSnapshot", approved_at: "old" }]
    });
    expect(filledFromLedger).toBe(0);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].approved_by).toBe("RealHuman");
  });
});

describe("the #315 regression: db-mode ids resolvable via the ledger", () => {
  // The exact line that failed CI on PR #315 -- T-0243's own archive_shelving row. It carries an
  // approval phrase and mentions three ids, none of which exist in tasks/*.md (which stops at
  // T-0222), so all three reported unverifiable-approval-claim and the gate failed closed.
  const ROW =
    "| `assets/final/props/signal_tower/archive_shelving_v1.png` (T-0243 — Records Room, SDXL) | " +
    "workflow (T-0220 committed cutout path) ... generated only after `signal_tower_props_concept_sheet_v3.png`'s " +
    "(T-0257) ASSET_PROVENANCE.md row read \"APPROVED 2026-08-30\" (PR #307). |";
  const newLines = new Set([ROW.trim()]);

  it("FAILS with no ledger -- reproducing the #315 red check", () => {
    const r = findApprovalDrift({ provenanceText: ROW, tasks: [], newLines });
    expect(r.ok).toBe(false);
    expect(r.drifts.map((d) => d.taskId).sort()).toEqual(["T-0220", "T-0243", "T-0257"]);
    expect(r.drifts.every((d) => d.kind === "unverifiable-approval-claim")).toBe(true);
  });

  it("PASSES once the ledger resolves those ids -- real verification, not a skip", () => {
    const ledger = {
      cards: [
        { id: "T-0243", requires_approval: false, approved_by: null, approved_at: null },
        { id: "T-0220", requires_approval: false, approved_by: null, approved_at: null },
        { id: "T-0257", requires_approval: true, approved_by: "Anonymous", approved_at: "2026-08-30T22:06:35.073Z" }
      ]
    };
    const { tasks } = mergeTasksWithLedger([], ledger);
    const r = findApprovalDrift({ provenanceText: ROW, tasks, newLines });
    expect(r.ok).toBe(true);
  });

  it("STILL CATCHES real drift through the ledger -- the gate is not defanged", () => {
    // T-0257 gated but with no approval recorded: the row's "APPROVED" claim is unsubstantiated.
    const ledger = {
      cards: [
        { id: "T-0243", requires_approval: false, approved_by: null, approved_at: null },
        { id: "T-0220", requires_approval: false, approved_by: null, approved_at: null },
        { id: "T-0257", requires_approval: true, approved_by: null, approved_at: null }
      ]
    };
    const { tasks } = mergeTasksWithLedger([], ledger);
    const r = findApprovalDrift({ provenanceText: ROW, tasks, newLines });
    expect(r.ok).toBe(false);
    expect(r.drifts.map((d) => d.kind)).toContain("unsubstantiated-approved-claim");
  });

  it("STILL CATCHES the T-0257 stale-unapproved case the gate was built for", () => {
    const stale = "| `signal_tower_props_concept_sheet_v3.png` (T-0257) ... **Not yet approved** -- parks for a verdict. |";
    const ledger = {
      cards: [{ id: "T-0257", requires_approval: true, approved_by: "Anonymous", approved_at: "2026-08-30T22:06:35.073Z" }]
    };
    const { tasks } = mergeTasksWithLedger([], ledger);
    const r = findApprovalDrift({ provenanceText: stale, tasks, newLines: new Set([stale.trim()]) });
    expect(r.ok).toBe(false);
    expect(r.drifts[0].kind).toBe("stale-unapproved-claim");
  });
});

describe("a row narrating an approval transition is not a stale claim (PR #315 false positive)", () => {
  // T-0243's shelving row quotes the SUPERSEDED wording while describing PR #307's fix. The
  // quoted "Not yet approved" is history; the row's live claim is APPROVED.
  const ROW =
    '| archive_shelving_v1.png (T-0243) | ... the sheet (T-0257) ASSET_PROVENANCE.md row was ' +
    'updated from "Not yet approved" to "APPROVED 2026-08-30" by PR #307. |';
  const approvedLedger = [
    { id: "T-0243", requires_approval: false, approved_by: null, approved_at: null },
    { id: "T-0257", requires_approval: true, approved_by: "Anonymous", approved_at: "2026-08-30T22:06:35.073Z" }
  ];

  it("does NOT report stale-unapproved when the board shows the card approved", () => {
    const r = findApprovalDrift({ provenanceText: ROW, tasks: approvedLedger, newLines: new Set([ROW.trim()]) });
    expect(r.drifts.filter((d) => d.kind === "stale-unapproved-claim")).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it("still FAILS the same row when the board does not substantiate the APPROVED claim", () => {
    const unapproved = [
      { id: "T-0243", requires_approval: false, approved_by: null, approved_at: null },
      { id: "T-0257", requires_approval: true, approved_by: null, approved_at: null }
    ];
    const r = findApprovalDrift({ provenanceText: ROW, tasks: unapproved, newLines: new Set([ROW.trim()]) });
    expect(r.ok).toBe(false);
    expect(r.drifts.map((d) => d.kind)).toContain("unsubstantiated-approved-claim");
  });

  it("still catches a pure stale claim -- narrowing did not defang the original check", () => {
    const pure = "| sheet_v3.png (T-0257) ... **Not yet approved** -- parks for a verdict. |";
    const r = findApprovalDrift({ provenanceText: pure, tasks: approvedLedger, newLines: new Set([pure.trim()]) });
    expect(r.ok).toBe(false);
    expect(r.drifts[0].kind).toBe("stale-unapproved-claim");
  });
});
