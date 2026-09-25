import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * T-0396: the mechanical, checkable half of per-attempt commit cadence -- a reviewer/deliverable
 * gate rule that fails a card whose evidence frames from two different attempts were first
 * committed together (T-0387, `22a2867`: three attempts, one commit; reviewers noted it but
 * could not fail it, since the cap was already spent). `attemptRecorder.js`'s `recordAttempt` is
 * the generator-side mechanism that produces the right commit shape going forward; this is the
 * independent, after-the-fact check that a reviewer or `checkDeliverable.js` runs against
 * whatever actually landed on the branch, regardless of how it got there.
 */

const ATTEMPT_FILE_RE = /^attempt_(\d+)_/;

/** The attempt number a `docs/assets/evidence/<card>/` filename declares (`attempt_1_main.png` -> 1), or `null` if it doesn't follow the convention. */
export function parseAttemptNumber(filename) {
  const match = ATTEMPT_FILE_RE.exec(filename);
  return match ? Number(match[1]) : null;
}

/** `{filename, path}` for every regular file directly under `evidenceDir`, or `[]` if it doesn't exist. */
export async function listEvidenceFiles(evidenceDir) {
  let entries;
  try {
    entries = await fs.readdir(evidenceDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({ filename: entry.name, path: path.join(evidenceDir, entry.name) }));
}

/** The earliest commit on the current branch that added `filePath`, or `null` if it was never added (untracked, or new/uncommitted). */
export async function defaultIntroducingCommit(repoRoot, filePath) {
  const rel = path.relative(repoRoot, filePath).split(path.sep).join("/");
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "log",
      "--diff-filter=A",
      "--format=%H",
      "--follow",
      "--",
      rel
    ]);
    const shas = stdout.split("\n").filter(Boolean);
    return shas.length > 0 ? shas[shas.length - 1] : null;
  } catch {
    return null;
  }
}

/**
 * Fails when two DIFFERENT attempts' evidence files share the same introducing commit -- i.e.
 * were batched into one commit instead of each landing in its own. Multiple files within the
 * SAME attempt sharing a commit (a frame plus its crops) is expected and not flagged. Not
 * applicable when fewer than two distinct attempt numbers are present in `evidenceFiles`.
 */
export async function checkAttemptCommitCadence({ evidenceFiles, introducingCommit }) {
  const byAttempt = new Map();
  for (const file of evidenceFiles) {
    const attempt = parseAttemptNumber(file.filename);
    if (attempt === null) continue;
    if (!byAttempt.has(attempt)) byAttempt.set(attempt, []);
    byAttempt.get(attempt).push(file);
  }

  if (byAttempt.size < 2) {
    return { ok: true, applicable: byAttempt.size > 0, errors: [] };
  }

  const commitsByAttempt = new Map();
  for (const [attempt, files] of byAttempt) {
    const commits = new Set();
    for (const file of files) {
      const sha = await introducingCommit(file.path);
      if (sha) commits.add(sha);
    }
    commitsByAttempt.set(attempt, commits);
  }

  const errors = [];
  const attempts = [...commitsByAttempt.keys()].sort((a, b) => a - b);
  for (let i = 0; i < attempts.length; i++) {
    for (let j = i + 1; j < attempts.length; j++) {
      const a = attempts[i];
      const b = attempts[j];
      const shared = [...commitsByAttempt.get(a)].filter((sha) => commitsByAttempt.get(b).has(sha));
      if (shared.length > 0) {
        errors.push(
          `attempt ${a} and attempt ${b}'s evidence frames were first committed in the same commit ` +
            `(${shared.join(", ")}) -- each attempt's frame must land in its own commit, not a batch.`
        );
      }
    }
  }

  return { ok: errors.length === 0, applicable: true, errors };
}
