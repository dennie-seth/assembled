/**
 * Owns the "kept candidates" table in a batch reference-sourcing summary (T-0282).
 *
 * T-0281 batch-fetched references for four poses and committed a per-pose summary recording
 * sha256/title/licence/retrievedAt for each candidate -- but not `assetId` or `sourceUrl`. Those
 * two fields lived only in the quarantine sidecar (`assets/src/reference/quarantine/`), which is
 * gitignored and does not survive worktree reclamation. Without a source URL, a licence claim on
 * a public repo cannot be independently re-verified after the fact -- see T-0273/278/279/280,
 * which all had to re-fetch from scratch because the recovery path did not exist.
 *
 * This module is the durable fix, applied where the summary is produced: it is the only place
 * that builds the candidates table, and it validates every record *before* rendering anything --
 * mirroring `tools/comfy-client/src/comfy_client/provenance_sidecar.py`'s pattern for the
 * `generator` field (validate first, "nothing written on rejection"). A future batch-fetch card
 * that renders its table through `renderCandidateTable` structurally cannot drop `assetId` or
 * `sourceUrl` for a candidate -- the call throws instead of producing markdown.
 *
 * `checkKeptProvenance` is the second half of the fix: a parser reused by
 * `tools/board/scripts/checkReferenceBatchSummary.js` (the mechanical enforcement gate wired into
 * verifyRouter.js) that inspects *any* markdown -- writer-produced or hand-authored -- for a
 * candidates table with a KEPT row lacking Asset ID / Source URL. It exists because prose
 * documentation of "always record the URL" already failed once (T-0281); this makes a repeat
 * mechanically visible in the review pipeline rather than depending on anyone remembering.
 */

export class ReferenceSummaryError extends Error {}

const REQUIRED_STRING_FIELDS = ["sha256", "title", "sourceId", "assetId", "sourceUrl", "license", "retrievedAt"];
const VALID_VERDICTS = new Set(["KEPT", "REJECTED"]);

/**
 * Throws `ReferenceSummaryError` unless `record` has every field a human needs to independently
 * re-verify this candidate's licence after quarantine is gone. `sourceUrl`/`assetId` are required
 * for a REJECTED candidate too, not just a KEPT one -- per T-0282's edge case, a rejection is
 * worth being able to re-check as well, and requiring it uniformly is simpler than a
 * verdict-conditional rule.
 */
export function validateCandidateRecord(record, index = 0) {
  if (record == null || typeof record !== "object") {
    throw new ReferenceSummaryError(`candidate[${index}]: record must be an object`);
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      const label = typeof record.title === "string" && record.title.length > 0 ? record.title : "untitled";
      throw new ReferenceSummaryError(`candidate[${index}] ("${label}"): "${field}" must be a non-empty string`);
    }
  }
  if (!/^https?:\/\//i.test(record.sourceUrl)) {
    throw new ReferenceSummaryError(
      `candidate[${index}] ("${record.title}"): "sourceUrl" must be an http(s) URL, got "${record.sourceUrl}"`
    );
  }
  if (!VALID_VERDICTS.has(record.verdict)) {
    throw new ReferenceSummaryError(
      `candidate[${index}] ("${record.title}"): "verdict" must be "KEPT" or "REJECTED", got ${JSON.stringify(record.verdict)}`
    );
  }
}

/**
 * Renders the `| File | Title | Source | Asset ID | Source URL | Licence | Retrieved | Verdict |`
 * table for a batch-fetch summary. Validates every candidate first -- a single invalid record
 * means nothing is rendered, not a table with a hole in it.
 */
export function renderCandidateTable(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new ReferenceSummaryError("renderCandidateTable requires at least one candidate record");
  }
  candidates.forEach((record, index) => validateCandidateRecord(record, index));

  const header = "| File (sha256 prefix) | Title | Source | Asset ID | Source URL | Licence | Retrieved | Verdict |";
  const separator = "|---|---|---|---|---|---|---|---|";
  const rows = candidates.map((record) => {
    const shaPrefix = record.sha256.slice(0, 10);
    const verdictLabel = record.verdict === "KEPT" ? "**KEPT**" : "REJECTED";
    const verdictCell = record.verdictReason ? `${verdictLabel} — ${record.verdictReason}` : verdictLabel;
    return (
      `| \`${shaPrefix}...\` | ${record.title} | ${record.sourceId} | \`${record.assetId}\` | ` +
      `${record.sourceUrl} | ${record.license} | ${record.retrievedAt} | ${verdictCell} |`
    );
  });
  return [header, separator, ...rows].join("\n");
}

/** Number of candidates in `candidates` whose verdict is KEPT. */
export function countKept(candidates) {
  return candidates.filter((record) => record.verdict === "KEPT").length;
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const SEPARATOR_ROW_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Parses every GFM pipe-table in `markdown` into `{headers, rows}` objects, in document order. */
export function parseMarkdownTables(markdown) {
  const lines = markdown.split(/\r?\n/);
  const tables = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    const headerLine = lines[i];
    const separatorLine = lines[i + 1];
    if (!headerLine.trim().startsWith("|") || !SEPARATOR_ROW_RE.test(separatorLine)) {
      continue;
    }
    const headers = splitRow(headerLine);
    const rows = [];
    let j = i + 2;
    while (j < lines.length && lines[j].trim().startsWith("|")) {
      rows.push(splitRow(lines[j]));
      j += 1;
    }
    tables.push({ headers, rows });
    i = j - 1;
  }
  return tables;
}

/**
 * Mechanical gate: does `markdown`'s candidates table (the first table with a "Verdict" column)
 * record an Asset ID and a plausible http(s) Source URL for every KEPT row? A table with zero
 * KEPT rows passes trivially -- there is nothing to re-verify yet. A document with no candidates
 * table at all fails, since a batch-fetch summary that kept anything must have one.
 *
 * Column lookup is by header text (case-insensitive "asset id" / "source url"), not fixed
 * position, so this also catches a hand-authored table that reorders columns -- and it is the
 * same parser `renderCandidateTable`'s output round-trips through, so the writer and the gate
 * cannot silently diverge on what "present" means.
 */
export function checkKeptProvenance(markdown) {
  const tables = parseMarkdownTables(markdown);
  const candidateTable = tables.find((table) => table.headers.some((header) => /verdict/i.test(header)));
  if (!candidateTable) {
    return { ok: false, errors: ['no candidates table found (a markdown table with a "Verdict" column)'] };
  }

  const verdictIdx = candidateTable.headers.findIndex((header) => /verdict/i.test(header));
  const assetIdIdx = candidateTable.headers.findIndex((header) => /asset\s*id/i.test(header));
  const sourceUrlIdx = candidateTable.headers.findIndex((header) => /source\s*url/i.test(header));
  const keptRows = candidateTable.rows.filter((row) => /kept/i.test(row[verdictIdx] ?? ""));

  if (keptRows.length === 0) {
    return { ok: true, errors: [] };
  }

  const errors = [];
  if (assetIdIdx === -1) {
    errors.push('candidates table has a kept image but no "Asset ID" column');
  }
  if (sourceUrlIdx === -1) {
    errors.push('candidates table has a kept image but no "Source URL" column');
  }
  if (assetIdIdx !== -1 && sourceUrlIdx !== -1) {
    keptRows.forEach((row, index) => {
      const label = row[0]?.trim() || `kept row ${index + 1}`;
      const assetId = (row[assetIdIdx] ?? "").trim();
      const sourceUrl = (row[sourceUrlIdx] ?? "").trim();
      if (!assetId || assetId === "-") {
        errors.push(`${label}: missing "Asset ID"`);
      }
      if (!sourceUrl || sourceUrl === "-") {
        errors.push(`${label}: missing "Source URL"`);
      } else if (!/^https?:\/\//i.test(sourceUrl.replace(/[`*_]/g, ""))) {
        errors.push(`${label}: "Source URL" ("${sourceUrl}") does not look like an http(s) URL`);
      }
    });
  }

  return { ok: errors.length === 0, errors };
}
