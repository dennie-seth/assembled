import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The set of lines (trimmed) that `git diff baseRef...HEAD -- file` *adds* -- the scoping
 * primitive `checkApprovalProvenanceDrift.js` uses so its loud unresolvable-card-reference check
 * (see `approvalProvenanceDrift.js`'s `newLines`) only ever fires on rows a PR actually
 * introduces, not on `ASSET_PROVENANCE.md`'s ~200 pre-existing rows.
 *
 * Returns `null` (never throws) when the diff can't be computed at all -- `baseRef` doesn't
 * exist, this isn't a git checkout, whatever -- since "can't tell what's new" must fall back to
 * the caller's own safe default (skip the loud check), not crash the whole run.
 */
export async function collectAddedLines({ cwd, baseRef, file }) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["diff", "--no-color", "--unified=0", `${baseRef}...HEAD`, "--", file],
      { cwd, maxBuffer: 1024 * 1024 * 16 }
    ));
  } catch {
    return null;
  }

  const added = new Set();
  for (const line of stdout.split("\n")) {
    if (line.startsWith("+++")) continue;
    if (line.startsWith("+")) added.add(line.slice(1).trim());
  }
  return added;
}
