import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Where an asset run's decisive frames land so they survive worktree removal and show up in the
 * PR diff -- see docs/assets/evidence-promotion.md for the full rationale (T-0314). One directory
 * per card, mirroring the manual convention T-0272's round 4 established by hand
 * (`docs/assets/evidence/T-0272/`).
 */
export const DEFAULT_EVIDENCE_ROOT = "docs/assets/evidence";

/**
 * Per-file byte cap. Measured against T-0272's own 35 hand-curated evidence files: 76.6KB average,
 * 131KB max, none anywhere near this. A frame this large is very likely a raw unquantized/upscaled
 * render rather than the small indexed sprite frames this path exists for -- reject it rather than
 * silently bloating the repo; see docs/assets/evidence-promotion.md for the downscale alternative.
 */
export const DEFAULT_MAX_FILE_BYTES = 200 * 1024;

/** Per-invocation file-count cap -- a round citing more than this is citing too many "decisive" frames. */
export const DEFAULT_MAX_FILES_PER_RUN = 20;

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif)$/i;
// A backtick span whose whole content is a bare relative path (no spaces, no leading slash, no
// scheme) ending in an image extension -- deliberately narrow so an inline-code command, a .md
// filename, or a config path is never mistaken for a cited frame.
const CITATION_PATTERN = /`([^`\s]+\.(?:png|jpe?g|webp|gif))`/gi;

/**
 * Every run-relative image path an attempt log cites via an inline-code span, in first-seen
 * order, deduped. This is the entire selection rule: a frame is a "decisive frame" iff the log's
 * own prose names it this way -- mechanical, bounded by what the log actually cites, and
 * unaffected by whether the round's own outcome was a promotion or a finding.
 */
export function parseCitedEvidencePaths(logText) {
  const seen = new Set();
  const ordered = [];
  for (const match of logText.matchAll(CITATION_PATTERN)) {
    const cited = match[1];
    if (!IMAGE_EXTENSIONS.test(cited)) continue;
    if (seen.has(cited)) continue;
    seen.add(cited);
    ordered.push(cited);
  }
  return ordered;
}

async function fileSize(target) {
  try {
    const stat = await fs.stat(target);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/** Resolves `cited` against `runDir`, refusing anything that would escape it (e.g. `../../secret.png`). */
function resolveWithinRunDir(runDir, cited) {
  const resolved = path.resolve(runDir, cited);
  const base = path.resolve(runDir) + path.sep;
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

/** `attempt_14/main_384.png` -> `attempt_14_main_384.png` -- unique per source path, traceable back to it. */
function destFileNameFor(cited) {
  return cited.split("/").join("_");
}

/** First destination name not already on disk: `name.png`, then `name__2.png`, `name__3.png`, ... */
async function firstAvailableDestPath(evidenceDir, destFileName) {
  const ext = path.extname(destFileName);
  const base = destFileName.slice(0, destFileName.length - ext.length);
  let candidate = path.join(evidenceDir, destFileName);
  let n = 2;
  while (await fileSize(candidate)) {
    candidate = path.join(evidenceDir, `${base}__${n}${ext}`);
    n += 1;
  }
  return candidate;
}

async function buffersEqual(a, b) {
  try {
    const [bufA, bufB] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return bufA.equals(bufB);
  } catch {
    return false;
  }
}

/**
 * Promotes the decisive frames one asset-run round cites into a tracked, committed path so they
 * survive the worktree that produced them being reaped (T-0314).
 *
 * Selection is entirely driven by `parseCitedEvidencePaths(logText)` -- bounded by what the log
 * actually names, capped by `maxFiles`/`maxFileBytes` so a round with dozens of attempts cannot
 * silently commit all of them. Runs on a finding round exactly the same as a promotion round: the
 * log citing a decisive-but-not-promotable frame is exactly the T-0272 case this exists for.
 *
 * Never throws on an unproductive run -- a missing runDir (crashed before generating), a missing
 * or not-yet-written log, or a citation that doesn't resolve to a real file all degrade to an
 * empty/partial result rather than failing the caller's run.
 *
 * Idempotent: re-promoting byte-identical content is a no-op (`unchanged`). A destination name
 * collision with *different* content (e.g. a later round's run directory happening to reuse the
 * same relative attempt path) never overwrites -- it lands beside the original with a numbered
 * suffix, so no earlier round's evidence is ever clobbered.
 *
 * @returns {Promise<{evidenceDir: string, promoted: Array<{cited: string, sourcePath: string, destPath: string, destRelPath: string, bytes: number}>, skippedMissing: string[], skippedTooLarge: Array<{cited: string, bytes: number}>, skippedOverCap: string[], unchanged: string[]}>}
 */
export async function promoteEvidence({
  repoRoot,
  cardId,
  runDir,
  logPath,
  evidenceRoot = DEFAULT_EVIDENCE_ROOT,
  maxFiles = DEFAULT_MAX_FILES_PER_RUN,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES
}) {
  const evidenceDir = path.join(repoRoot, evidenceRoot, cardId);

  let logText = "";
  try {
    logText = await fs.readFile(logPath, "utf8");
  } catch {
    // Log not written yet (or already gone) -- nothing to cite, nothing to promote.
  }
  const cited = parseCitedEvidencePaths(logText);

  const promoted = [];
  const skippedMissing = [];
  const skippedTooLarge = [];
  const skippedOverCap = [];
  const unchanged = [];

  for (const citedPath of cited) {
    if (promoted.length >= maxFiles) {
      skippedOverCap.push(citedPath);
      continue;
    }

    const sourcePath = resolveWithinRunDir(runDir, citedPath);
    const bytes = sourcePath ? await fileSize(sourcePath) : null;
    if (bytes === null) {
      skippedMissing.push(citedPath);
      continue;
    }
    if (bytes > maxFileBytes) {
      skippedTooLarge.push({ cited: citedPath, bytes });
      continue;
    }

    const destFileName = destFileNameFor(citedPath);
    const existingSamePath = path.join(evidenceDir, destFileName);
    if (await fileSize(existingSamePath)) {
      if (await buffersEqual(sourcePath, existingSamePath)) {
        unchanged.push(citedPath);
        continue;
      }
    }

    const destPath = await firstAvailableDestPath(evidenceDir, destFileName);
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.copyFile(sourcePath, destPath);
    promoted.push({
      cited: citedPath,
      sourcePath,
      destPath,
      destRelPath: path.join(evidenceRoot, cardId, path.basename(destPath)).split(path.sep).join("/"),
      bytes
    });
  }

  return { evidenceDir, promoted, skippedMissing, skippedTooLarge, skippedOverCap, unchanged };
}
