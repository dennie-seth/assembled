import { describe, it, expect } from "vitest";
import {
  ReferenceSummaryError,
  validateCandidateRecord,
  renderCandidateTable,
  countKept,
  parseMarkdownTables,
  checkKeptProvenance
} from "../src/lib/referenceBatchSummary.js";

// A minimal, fully-populated KEPT candidate -- shape mirrors referenceSourcing.js's
// `fetchReference` provenance record (sourceId, assetId, title, sourceUrl, license,
// retrievedAt) plus sha256 from the quarantine sidecar and a verdict/verdictReason the
// curating agent adds.
function keptCandidate(overrides = {}) {
  return {
    sha256: "b1006b0a72aabbccddeeff00112233445566778899aabbccddeeff00112233",
    title: "Silhouette walking man png illustration",
    sourceId: "openverse",
    assetId: "6c1c1e6b-abcd-4e12-9f34-000000000001",
    sourceUrl: "https://api.openverse.org/v1/images/6c1c1e6b/thumb/",
    license: "cc0",
    retrievedAt: "2026-09-01T17:16:17.577Z",
    verdict: "KEPT",
    verdictReason: "clean, true side-on silhouette",
    ...overrides
  };
}

function rejectedCandidate(overrides = {}) {
  return keptCandidate({
    sha256: "fc7fbd13ce0011223344556677889900aabbccddeeff0011223344556677fc",
    title: "Man walking in silhouette",
    assetId: "9e2d2f7c-abcd-4e12-9f34-000000000002",
    sourceUrl: "https://api.openverse.org/v1/images/9e2d2f7c/thumb/",
    license: "by",
    retrievedAt: "2026-09-01T17:16:15.750Z",
    verdict: "REJECTED",
    verdictReason: "three-quarter facing, not a true profile",
    ...overrides
  });
}

describe("validateCandidateRecord -- owns assetId/sourceUrl the way provenance_sidecar.py owns generator", () => {
  it("accepts a fully-populated KEPT candidate", () => {
    expect(() => validateCandidateRecord(keptCandidate(), 0)).not.toThrow();
  });

  it("accepts a fully-populated REJECTED candidate", () => {
    expect(() => validateCandidateRecord(rejectedCandidate(), 0)).not.toThrow();
  });

  it("throws when assetId is missing on a KEPT candidate", () => {
    const record = keptCandidate({ assetId: "" });
    expect(() => validateCandidateRecord(record, 0)).toThrow(ReferenceSummaryError);
    expect(() => validateCandidateRecord(record, 0)).toThrow(/assetId/);
  });

  it("throws when assetId is missing entirely (undefined)", () => {
    const record = keptCandidate();
    delete record.assetId;
    expect(() => validateCandidateRecord(record, 0)).toThrow(ReferenceSummaryError);
  });

  it("throws when sourceUrl is missing on a KEPT candidate", () => {
    const record = keptCandidate({ sourceUrl: "" });
    expect(() => validateCandidateRecord(record, 0)).toThrow(/sourceUrl/);
  });

  it("throws when sourceUrl is not an http(s) URL", () => {
    const record = keptCandidate({ sourceUrl: "not-a-url" });
    expect(() => validateCandidateRecord(record, 0)).toThrow(/http/);
  });

  it("throws when sourceUrl is missing on a REJECTED candidate too (rejections must be re-checkable as well)", () => {
    const record = rejectedCandidate({ sourceUrl: "" });
    expect(() => validateCandidateRecord(record, 0)).toThrow(/sourceUrl/);
  });

  it("throws on an unrecognized verdict", () => {
    const record = keptCandidate({ verdict: "MAYBE" });
    expect(() => validateCandidateRecord(record, 0)).toThrow(/verdict/);
  });

  it("throws on a missing license", () => {
    const record = keptCandidate({ license: "" });
    expect(() => validateCandidateRecord(record, 0)).toThrow(/license/);
  });

  it("throws on a missing retrievedAt", () => {
    const record = keptCandidate({ retrievedAt: "" });
    expect(() => validateCandidateRecord(record, 0)).toThrow(/retrievedAt/);
  });

  it("includes the candidate index in the error message", () => {
    const record = keptCandidate({ assetId: "" });
    expect(() => validateCandidateRecord(record, 3)).toThrow(/candidate\[3\]/);
  });
});

describe("renderCandidateTable -- nothing is written on rejection", () => {
  it("renders a table with Asset ID and Source URL columns for a mix of kept/rejected candidates", () => {
    const table = renderCandidateTable([keptCandidate(), rejectedCandidate()]);
    expect(table).toContain("Asset ID");
    expect(table).toContain("Source URL");
    expect(table).toContain(keptCandidate().assetId);
    expect(table).toContain(keptCandidate().sourceUrl);
    expect(table).toContain(rejectedCandidate().assetId);
    expect(table).toContain(rejectedCandidate().sourceUrl);
  });

  it("throws instead of rendering anything when one candidate in the batch is missing sourceUrl", () => {
    const bad = keptCandidate({ sourceUrl: "" });
    expect(() => renderCandidateTable([keptCandidate(), bad])).toThrow(ReferenceSummaryError);
  });

  it("throws on an empty candidate list rather than rendering a headers-only table", () => {
    expect(() => renderCandidateTable([])).toThrow(ReferenceSummaryError);
  });

  it("round-trips through the same parser the enforcement gate uses -- kept row passes checkKeptProvenance", () => {
    const table = renderCandidateTable([keptCandidate(), rejectedCandidate()]);
    const report = checkKeptProvenance(table);
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });
});

describe("countKept", () => {
  it("counts only KEPT verdicts", () => {
    expect(countKept([keptCandidate(), rejectedCandidate(), keptCandidate()])).toBe(2);
  });
});

describe("parseMarkdownTables", () => {
  it("parses a single GFM table into headers + rows", () => {
    const markdown = ["| A | B |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |"].join("\n");
    const tables = parseMarkdownTables(markdown);
    expect(tables).toHaveLength(1);
    expect(tables[0].headers).toEqual(["A", "B"]);
    expect(tables[0].rows).toEqual([
      ["1", "2"],
      ["3", "4"]
    ]);
  });

  it("returns an empty array for markdown with no tables", () => {
    expect(parseMarkdownTables("# Just a heading\n\nSome prose.")).toEqual([]);
  });

  it("parses multiple tables in one document", () => {
    const markdown = ["| A |", "|---|", "| 1 |", "", "prose in between", "", "| B |", "|---|", "| 2 |"].join("\n");
    const tables = parseMarkdownTables(markdown);
    expect(tables).toHaveLength(2);
    expect(tables[0].headers).toEqual(["A"]);
    expect(tables[1].headers).toEqual(["B"]);
  });
});

describe("checkKeptProvenance -- mechanical gate, independent of whether the writer was used", () => {
  it("passes a table with a Verdict column but zero KEPT rows", () => {
    const markdown = ["| Title | Verdict |", "|---|---|", "| x | REJECTED |"].join("\n");
    expect(checkKeptProvenance(markdown)).toEqual({ ok: true, errors: [] });
  });

  it("fails when there is no candidates table at all (no Verdict column anywhere)", () => {
    const report = checkKeptProvenance("# Some summary\n\nJust prose, no table.");
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(/no candidates table/i);
  });

  it("fails when a KEPT row exists but the table has no Asset ID column at all -- this is the exact T-0281 shape", () => {
    const markdown = [
      "| File (sha256 prefix) | Title | Source | Licence | Retrieved | Verdict |",
      "|---|---|---|---|---|---|",
      "| `b1006b0a72...` | some title | openverse | cc0 | 2026-09-01T17:16:17.577Z | **KEPT** — clean profile |"
    ].join("\n");
    const report = checkKeptProvenance(markdown);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => /Asset ID/.test(e))).toBe(true);
    expect(report.errors.some((e) => /Source URL/.test(e))).toBe(true);
  });

  it("fails when the Asset ID column exists but is blank for a kept row", () => {
    const markdown = [
      "| File | Asset ID | Source URL | Verdict |",
      "|---|---|---|---|",
      "| f1 |  | https://example.org/a | KEPT |"
    ].join("\n");
    const report = checkKeptProvenance(markdown);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => /Asset ID/.test(e))).toBe(true);
  });

  it("fails when the Source URL column exists but is blank for a kept row", () => {
    const markdown = ["| File | Asset ID | Source URL | Verdict |", "|---|---|---|---|", "| f1 | asset-1 |  | KEPT |"].join(
      "\n"
    );
    const report = checkKeptProvenance(markdown);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => /Source URL/.test(e))).toBe(true);
  });

  it("fails when Source URL is present but not an http(s) URL", () => {
    const markdown = [
      "| File | Asset ID | Source URL | Verdict |",
      "|---|---|---|---|",
      "| f1 | asset-1 | not-a-url | KEPT |"
    ].join("\n");
    const report = checkKeptProvenance(markdown);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => /does not look like/.test(e))).toBe(true);
  });

  it("passes when every kept row has both Asset ID and Source URL populated", () => {
    const markdown = [
      "| File | Asset ID | Source URL | Verdict |",
      "|---|---|---|---|",
      "| f1 | asset-1 | https://example.org/a | KEPT |",
      "| f2 | asset-2 | https://example.org/b | REJECTED |"
    ].join("\n");
    const report = checkKeptProvenance(markdown);
    expect(report).toEqual({ ok: true, errors: [] });
  });

  it("does not require Asset ID/Source URL for rejected-only rows even when the columns are absent", () => {
    const markdown = ["| File | Verdict |", "|---|---|", "| f1 | REJECTED |", "| f2 | rejected |"].join("\n");
    expect(checkKeptProvenance(markdown)).toEqual({ ok: true, errors: [] });
  });
});
