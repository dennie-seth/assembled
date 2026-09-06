import { promises as fs } from "node:fs";
import path from "node:path";
import { findApprovalDrift } from "./approvalProvenanceDrift.js";

const DEFAULT_PROVENANCE_RELATIVE_PATH = "ASSET_PROVENANCE.md";

/**
 * Live counterpart to `checkApprovalProvenanceDrift.js`'s CI check, for the one thing CI
 * structurally cannot do: read the board's own just-written approval record and the real
 * `ASSET_PROVENANCE.md` on disk together, on the same machine, at the exact moment a human's
 * approval is stamped (`httpApi.js`'s two approval write paths -- drag-to-Done and an "APPROVED"
 * comment). CI's fresh-checkout runner has no access to this board's db for any card created
 * after the cards-to-database migration (T-0223+, including T-0257 itself) -- this function runs
 * inside the live server process instead, where that gap doesn't exist at all.
 *
 * Returns a human-readable notice string when `task`'s approval (already recorded on `task` by
 * the caller) contradicts `ASSET_PROVENANCE.md`'s own prose about it, or `null` when there is
 * nothing to say -- the file is absent, has no row for this card, or the row already agrees.
 * Read-only, exactly like the CI check: never writes `ASSET_PROVENANCE.md`, never mints or
 * alters an approval record. The caller decides what to do with the notice (`httpApi.js` posts
 * it as an informational board comment on the same card).
 */
export async function approvalProvenanceStaleNotice({ repoRoot, task, provenancePath }) {
  if (!repoRoot || !task) return null;
  const resolvedPath = provenancePath || path.join(repoRoot, DEFAULT_PROVENANCE_RELATIVE_PATH);

  let provenanceText;
  try {
    provenanceText = await fs.readFile(resolvedPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  const { drifts } = findApprovalDrift({ provenanceText, tasks: [task] });
  const drift = drifts.find((d) => d.taskId === task.id && d.kind === "stale-unapproved-claim");
  if (!drift) return null;

  return (
    `ASSET_PROVENANCE.md still reads unapproved for ${task.id}, but this approval is now recorded ` +
    `on the board (approved_by=${task.approved_by} at ${task.approved_at}). The board record is ` +
    `authoritative (T-0286, docs/decision-log.md DL-27) -- refresh ASSET_PROVENANCE.md's row if you ` +
    `want the file to read correctly, but nothing downstream is blocked on it.`
  );
}
