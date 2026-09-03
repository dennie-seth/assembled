import { promises as fs } from "node:fs";
import path from "node:path";
import { findApprovalDrift, STALE_PHRASES } from "./approvalProvenanceDrift.js";

const DEFAULT_PROVENANCE_RELATIVE_PATH = "ASSET_PROVENANCE.md";

/**
 * The write-through half of the T-0257/T-0243 fix (T-0286, docs/decision-log.md DL-27 addendum).
 *
 * `approvalVerdict`/`GET /api/tasks/:id/approval` (`approvalGate.js`) already give any consumer
 * with board access a single, resolvable answer -- but `ASSET_PROVENANCE.md`'s prose is also read
 * directly and offline by consumers outside this agent's own path scope (`tools/**`, `.github/**`,
 * `.claude/**`, `docs/**`): the `assets` package's own pytest gates do a plain `"APPROVED" in row`
 * substring check against the file on disk, and redirecting them means editing
 * `assets/src/concept/tests/**`, which belongs to a different implementer agent entirely.
 * Reporting the contradiction (`approvalProvenanceNotice.js`'s read-only notice) does not help
 * those consumers; only a corrected file does. This function performs exactly that correction, and
 * nothing else:
 *
 *  - it only ever touches a row `findApprovalDrift` has independently flagged as
 *    `stale-unapproved-claim` for the given task -- an already-agreeing row, a row for an unrelated
 *    card, or any row for a card with no recorded approval yet is left completely untouched;
 *  - it forwards `task.approved_by`/`task.approved_at` verbatim -- both of which can only already
 *    exist on the task because a human AP-3/AP-4 gesture put them there (`approvalGate.js`) -- and
 *    has no parameter or code path that could set either field itself, so it can never mint an
 *    approval, only propagate one that already happened;
 *  - it rewrites only the matched stale phrase within the one matching line, leaving every other
 *    line, and the rest of that line, byte-for-byte as written -- no existing already-approved row
 *    is ever touched (T-0286's "existing records are not rewritten" criterion).
 */
export function syncApprovalProvenanceText({ provenanceText, task }) {
  if (!task || typeof provenanceText !== "string") return null;

  const { drifts } = findApprovalDrift({ provenanceText, tasks: [task] });
  const isStale = drifts.some((d) => d.taskId === task.id && d.kind === "stale-unapproved-claim");
  if (!isStale) return null;

  const lines = provenanceText.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(task.id)) continue;

    const stalePattern = STALE_PHRASES.find((re) => re.test(line));
    if (!stalePattern) continue;

    const dateOnly = typeof task.approved_at === "string" ? task.approved_at.slice(0, 10) : "";
    const replacement =
      `APPROVED ${dateOnly} (board record: approved_by="${task.approved_by}", ` +
      `approved_at=${task.approved_at} -- auto-synced by T-0286; the board record is authoritative, ` +
      `this text mirrors it for a reader with no board access)`;

    const newLine = line.replace(stalePattern, replacement);
    if (newLine === line) continue;

    const newLines = [...lines];
    newLines[i] = newLine;
    return { text: newLines.join("\n"), taskId: task.id, previousLine: line, newLine };
  }

  return null;
}

/**
 * File-system counterpart to `syncApprovalProvenanceText`: reads the real `ASSET_PROVENANCE.md`
 * in `repoRoot`, and if it has a stale row for `task`, rewrites it on disk and returns the sync
 * result. Returns `null` -- and writes nothing -- when the file is absent or there is nothing to
 * sync, exactly like `syncApprovalProvenanceText`'s own null cases.
 */
export async function refreshApprovalProvenanceFile({ repoRoot, task, provenancePath }) {
  if (!repoRoot || !task) return null;
  const resolvedPath = provenancePath || path.join(repoRoot, DEFAULT_PROVENANCE_RELATIVE_PATH);

  let provenanceText;
  try {
    provenanceText = await fs.readFile(resolvedPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  const result = syncApprovalProvenanceText({ provenanceText, task });
  if (!result) return null;

  await fs.writeFile(resolvedPath, result.text, "utf8");
  return { ...result, path: resolvedPath };
}
