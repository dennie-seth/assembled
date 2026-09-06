import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncApprovalProvenanceText, refreshApprovalProvenanceFile } from "../src/lib/approvalProvenanceSync.js";

/**
 * `syncApprovalProvenanceText` / `refreshApprovalProvenanceFile` (T-0286, docs/decision-log.md
 * DL-27 addendum): the write-through half of the T-0257/T-0243 fix.
 *
 * `approvalGate.js`'s `approvalVerdict` and `GET /api/tasks/:id/approval` make the board record
 * resolvable by anything that can reach the board -- but `ASSET_PROVENANCE.md`'s prose is also
 * read directly, offline, by consumers this card's own agent has no path scope to change (the
 * `assets` package's own pytest gates, e.g. `test_t0257_concept_sheet_is_approved`, which do a
 * plain `"APPROVED" in row` substring check against the file on disk). Redirecting those gates at
 * the board API would mean editing `assets/src/concept/tests/**`, outside `infra`'s scope
 * (tools/**, .github/**, .claude/**, docs/**) entirely. So instead of only *reporting* the
 * contradiction (`approvalProvenanceNotice.js`'s read-only notice), this module actually refreshes
 * the specific stale row so those existing offline consumers see the true state without needing
 * their own code touched.
 *
 * The guardrail is unchanged: this can only ever forward an approval that already exists on the
 * task (`approved_by`/`approved_at` already stamped by a human AP-3/AP-4 gesture) -- it has no
 * parameter or code path that could mint one, and a task that is gated but NOT yet approved is
 * left completely untouched, same as an already-agreeing row or a row for an unrelated card.
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

describe("syncApprovalProvenanceText", () => {
  it(
    "reproduces the exact T-0243 scenario and fixes it: a stale 'not yet approved' row for a " +
      "card the board already approved is rewritten to carry the board's existing human stamp",
    () => {
      const provenanceText =
        "| `assets/src/concept/signal_tower_props_concept_sheet_v3.png` (T-0257 — replaces the " +
        "declined v2 sheet) | ... **Not yet approved** — this card parks for a human direction " +
        "verdict per the §23-h pattern; no approval record is written here by the agent. | MIT | ... |";

      const t0257 = task({ status: "done", approved_by: "Anonymous", approved_at: "2026-08-30T22:06:35.073Z" });

      const result = syncApprovalProvenanceText({ provenanceText, task: t0257 });

      expect(result).not.toBeNull();
      expect(result.text).toContain("T-0257");
      expect(result.text).toMatch(/\bAPPROVED\b/);
      expect(result.text).not.toMatch(/not yet approved/i);
      expect(result.text).toContain("Anonymous");
      expect(result.text).toContain("2026-08-30T22:06:35.073Z");
    }
  );

  it("carries only the board's existing stamp verbatim -- never invents approved_by/approved_at", () => {
    const provenanceText = "| sheet.png (T-0257 -- not yet approved) | MIT | ... |";
    const t0257 = task({ status: "done", approved_by: "DennieSeth", approved_at: "2026-09-01T00:00:00.000Z" });

    const result = syncApprovalProvenanceText({ provenanceText, task: t0257 });

    expect(result.text).toContain("DennieSeth");
    expect(result.text).toContain("2026-09-01T00:00:00.000Z");
    expect(result.text).not.toContain("Anonymous");
  });

  it("does nothing when the card is gated but not yet approved -- refuses to mint an approval", () => {
    const provenanceText = "| sheet.png (T-0257 -- not yet approved) | MIT | ... |";
    const t0257 = task({ status: "review", approved_by: null, approved_at: null });

    expect(syncApprovalProvenanceText({ provenanceText, task: t0257 })).toBeNull();
    // and the row is left byte-for-byte untouched -- there is nothing to sync it to.
  });

  it("does nothing when the card does not require approval", () => {
    const provenanceText = "| sheet.png (T-0257 -- not yet approved) | MIT | ... |";
    const t0257 = task({ requires_approval: false });

    expect(syncApprovalProvenanceText({ provenanceText, task: t0257 })).toBeNull();
  });

  it("does nothing when the provenance row already agrees with the board", () => {
    const provenanceText = "| sheet.png (T-0257 -- **APPROVED 2026-08-30**) | MIT | ... |";
    const t0257 = task({ status: "done", approved_by: "Anonymous", approved_at: "2026-08-30T22:06:35.073Z" });

    expect(syncApprovalProvenanceText({ provenanceText, task: t0257 })).toBeNull();
  });

  it("does nothing when there is no row for this card at all", () => {
    const provenanceText = "| some_other_asset.png (T-0111 -- **APPROVED**) | MIT | ... |";
    const t0257 = task({ status: "done", approved_by: "Anonymous", approved_at: "2026-08-30T22:06:35.073Z" });

    expect(syncApprovalProvenanceText({ provenanceText, task: t0257 })).toBeNull();
  });

  it("touches only the matching row -- every other line is byte-for-byte unchanged", () => {
    const unrelatedLine = "| other_asset.png (T-0111 -- **APPROVED**) | MIT | ... | seed=9 |";
    const staleLine = "| sheet.png (T-0257 -- not yet approved) | MIT | ... |";
    const provenanceText = [unrelatedLine, staleLine, unrelatedLine].join("\n");
    const t0257 = task({ status: "done", approved_by: "Anonymous", approved_at: "2026-08-30T22:06:35.073Z" });

    const result = syncApprovalProvenanceText({ provenanceText, task: t0257 });
    const lines = result.text.split("\n");

    expect(lines[0]).toBe(unrelatedLine);
    expect(lines[2]).toBe(unrelatedLine);
    expect(lines[1]).not.toBe(staleLine);
  });

  it("is idempotent -- syncing an already-synced row a second time is a no-op", () => {
    const provenanceText = "| sheet.png (T-0257 -- not yet approved) | MIT | ... |";
    const t0257 = task({ status: "done", approved_by: "Anonymous", approved_at: "2026-08-30T22:06:35.073Z" });

    const first = syncApprovalProvenanceText({ provenanceText, task: t0257 });
    const second = syncApprovalProvenanceText({ provenanceText: first.text, task: t0257 });

    expect(second).toBeNull();
  });

  it("never mutates the input string", () => {
    const provenanceText = "| sheet.png (T-0257 -- not yet approved) | MIT | ... |";
    const original = provenanceText;
    const t0257 = task({ status: "done", approved_by: "Anonymous", approved_at: "2026-08-30T22:06:35.073Z" });

    syncApprovalProvenanceText({ provenanceText, task: t0257 });

    expect(provenanceText).toBe(original);
  });
});

describe("refreshApprovalProvenanceFile", () => {
  async function withRepo(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-provenance-sync-"));
    try {
      await fn(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it("writes the synced text back to ASSET_PROVENANCE.md on disk", async () => {
    await withRepo(async (dir) => {
      const provenancePath = path.join(dir, "ASSET_PROVENANCE.md");
      await fs.writeFile(provenancePath, "| sheet.png (T-0257 -- not yet approved) | MIT | ... |\n", "utf8");
      const t0257 = task({ status: "done", approved_by: "Anonymous", approved_at: "2026-08-30T22:06:35.073Z" });

      const result = await refreshApprovalProvenanceFile({ repoRoot: dir, task: t0257 });

      expect(result).not.toBeNull();
      const onDisk = await fs.readFile(provenancePath, "utf8");
      expect(onDisk).toMatch(/\bAPPROVED\b/);
      expect(onDisk).not.toMatch(/not yet approved/i);
    });
  });

  it("returns null and writes nothing when the file does not exist", async () => {
    await withRepo(async (dir) => {
      const t0257 = task({ status: "done", approved_by: "Anonymous", approved_at: "2026-08-30T22:06:35.073Z" });

      const result = await refreshApprovalProvenanceFile({ repoRoot: dir, task: t0257 });

      expect(result).toBeNull();
    });
  });

  it("returns null and leaves the file untouched when there is nothing to sync", async () => {
    await withRepo(async (dir) => {
      const provenancePath = path.join(dir, "ASSET_PROVENANCE.md");
      const original = "| sheet.png (T-0257 -- **APPROVED 2026-08-30**) | MIT | ... |\n";
      await fs.writeFile(provenancePath, original, "utf8");
      const t0257 = task({ status: "done", approved_by: "Anonymous", approved_at: "2026-08-30T22:06:35.073Z" });

      const result = await refreshApprovalProvenanceFile({ repoRoot: dir, task: t0257 });

      expect(result).toBeNull();
      expect(await fs.readFile(provenancePath, "utf8")).toBe(original);
    });
  });
});
