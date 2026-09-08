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

// A markdown table data row: starts and ends with `|`. If its own leading cell is a bare integer,
// that integer is the row's attempt number -- unconditionally, regardless of any *other* attempt
// number mentioned in that row's own prose (e.g. "matches attempt 30's result" inside attempt 31's
// own row still belongs to attempt 31: the row's own subject always wins over a cross-reference).
const TABLE_ROW_PATTERN = /^\s*\|.*\|\s*$/;
const TABLE_ROW_ATTEMPT_PATTERN = /^\s*\|\s*(\d+)\s*\|/;

// A prose mention of a specific attempt: "Attempt 39", "attempt 41's", "attempts 39, 40" (only the
// first number of a list is captured -- it is only ever used to disambiguate a bare-filename
// citation appearing in the very same sentence, never to enumerate every number named).
const ATTEMPT_MENTION_PATTERN = /\battempts?\s+(\d+)\b/gi;

// End of a sentence: a period followed by whitespace, a closing `**` bold marker, or end of
// string. Deliberately excludes a bare decimal like `0.15`/`31.416`, which is always followed
// directly by a digit, never by whitespace or `**`.
const SENTENCE_END_PATTERN = /\.(?=\s|\*\*|$)/g;

function addResolved(resolved, seen, ordered) {
  if (seen.has(resolved)) return;
  seen.add(resolved);
  ordered.push(resolved);
}

/**
 * The nearest attempt number named in a same-sentence prose mention preceding `citationIndex` in
 * `blockText` -- e.g. "attempt 39's `main_384.png`" resolves to `"39"`. Never looks past the most
 * recent sentence boundary and never looks forward, so an unrelated "Attempt N" appearing later in
 * the same paragraph (or naming a different attempt in an earlier sentence) is never attributed to
 * a citation it doesn't actually belong to -- returns null rather than guessing wrong.
 */
function nearestPrecedingAttempt(blockText, citationIndex) {
  const prefix = blockText.slice(0, citationIndex);
  let sentenceStart = 0;
  for (const match of prefix.matchAll(SENTENCE_END_PATTERN)) {
    sentenceStart = match.index + 1;
  }
  const sentence = blockText.slice(sentenceStart, citationIndex);
  let nearest = null;
  for (const match of sentence.matchAll(ATTEMPT_MENTION_PATTERN)) {
    nearest = match[1]; // matchAll preserves order, so the last match is the nearest one
  }
  return nearest;
}

function resolveBareCitation(cited, blockText, citationIndex) {
  const attemptNumber = nearestPrecedingAttempt(blockText, citationIndex);
  return attemptNumber ? `attempt_${attemptNumber}/${cited}` : cited;
}

function extractFromProseBlock(blockText, seen, ordered) {
  for (const match of blockText.matchAll(CITATION_PATTERN)) {
    const cited = match[1];
    if (!IMAGE_EXTENSIONS.test(cited)) continue;
    const resolved = cited.includes("/") ? cited : resolveBareCitation(cited, blockText, match.index);
    addResolved(resolved, seen, ordered);
  }
}

function extractFromTableBlock(lines, seen, ordered) {
  for (const line of lines) {
    const tableMatch = TABLE_ROW_ATTEMPT_PATTERN.exec(line);
    for (const match of line.matchAll(CITATION_PATTERN)) {
      const cited = match[1];
      if (!IMAGE_EXTENSIONS.test(cited)) continue;
      const resolved = cited.includes("/") || !tableMatch ? cited : `attempt_${tableMatch[1]}/${cited}`;
      addResolved(resolved, seen, ordered);
    }
  }
}

/**
 * Every run-relative image path an attempt log cites via an inline-code span, in first-seen
 * order, deduped. This is the entire selection rule: a frame is a "decisive frame" iff the log's
 * own prose names it this way -- mechanical, bounded by what the log actually cites, and
 * unaffected by whether the round's own outcome was a promotion or a finding.
 *
 * A citation is either already run-relative (`` `attempt_14/main_384.png` ``, used as-is) or a
 * bare filename (`` `main_384.png` ``) -- the shape T-0272's own real attempt log actually uses
 * throughout. A bare filename is resolved against whichever attempt it is cited *for*: a markdown
 * table row's own leading attempt-number cell, or the nearest "attempt N" mention in the same
 * sentence of surrounding prose. A bare filename with no such context (e.g. a conditioning input
 * that sits at the top of the run directory, like `pose_skeleton_384.png`) is left unresolved and
 * promoted from the top of `runDir` directly. Paragraphs are reconstituted across hard-wrapped
 * source lines (no blank line between them) before resolution, so a citation and the attempt
 * mention that names it are seen together even when the log's own line-wrapping split them.
 */
export function parseCitedEvidencePaths(logText) {
  const seen = new Set();
  const ordered = [];
  for (const block of logText.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;
    if (lines.every((line) => TABLE_ROW_PATTERN.test(line))) {
      extractFromTableBlock(lines, seen, ordered);
    } else {
      extractFromProseBlock(lines.join(" "), seen, ordered);
    }
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
  while ((await fileSize(candidate)) !== null) {
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
// `.claude/rules/assets.md`'s own blocked-generation-log convention: `ARM_<NAME>_ATTEMPT_LOG_<CARD>.md`,
// e.g. `ARM_HYBRID_ATTEMPT_LOG_T0272.md`. The `<CARD>` segment is the card id with its dash
// removed (`T-0272` -> `T0272`) -- verified against that exact file's own name in this repo.
const ATTEMPT_LOG_FILENAME_PATTERN = /^ARM_.+_ATTEMPT_LOG_(.+)\.md$/;

/** `T-0272` -> `T0272` -- the card-id form the attempt-log filename convention uses. */
function attemptLogCardSuffix(cardId) {
  return cardId.replace(/-/g, "");
}

/**
 * Every `ARM_*_ATTEMPT_LOG_<cardId>.md` file under `<repoRoot>/assets/src/` (any depth), paired
 * with every top-level directory under `<repoRoot>/assets/out/` -- the round-level run
 * directories a citation inside one of those logs is resolved relative to.
 *
 * Nothing on disk records which run directory a given attempt log's citations belong to, so this
 * returns every candidate rather than guessing one: `promoteEvidenceForCard` tries each log
 * against each run dir, and a citation that isn't actually under a given candidate simply reports
 * `skippedMissing` for that pairing (the same "never fatal" behaviour `promoteEvidence` already
 * has) rather than the caller needing to know the mapping upfront.
 *
 * Best-effort discovery, never throws: a card that never touched `assets/**` -- overwhelmingly
 * the common case for every other agent's cards -- has neither directory at all, and that
 * degrades to two empty lists rather than an ENOENT escaping to the caller.
 */
export async function discoverEvidenceSources({ repoRoot, cardId }) {
  const suffix = attemptLogCardSuffix(cardId);

  const logPaths = [];
  try {
    const entries = await fs.readdir(path.join(repoRoot, "assets", "src"), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = ATTEMPT_LOG_FILENAME_PATTERN.exec(entry.name);
      if (match && match[1] === suffix) {
        logPaths.push(path.join(entry.parentPath ?? entry.path, entry.name));
      }
    }
  } catch {
    // No assets/src tree at all -- nothing to find.
  }
  logPaths.sort();

  const runDirs = [];
  try {
    const entries = await fs.readdir(path.join(repoRoot, "assets", "out"), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) runDirs.push(path.join(repoRoot, "assets", "out", entry.name));
    }
  } catch {
    // No assets/out tree at all -- nothing generated (or already reaped).
  }
  runDirs.sort();

  return { logPaths, runDirs };
}

/**
 * Promotes a card's decisive attempt frames with no caller-supplied `runDir`/`logPath` -- the
 * entry point an automated caller (e.g. `runOrchestrator.js`'s pre-commit PASS step) uses, since
 * it cannot know either path ahead of time. Discovers both via `discoverEvidenceSources` and runs
 * `promoteEvidence` once per (log, run dir) candidate pair, merging the results.
 *
 * `maxFiles` is a total across every pairing, not a per-pairing allowance -- each call passes
 * down whatever budget the merged result hasn't already spent, so a log cited against several
 * candidate run dirs can never promote more than `maxFiles` frames in total just because more
 * than one candidate existed.
 */
export async function promoteEvidenceForCard({
  repoRoot,
  cardId,
  evidenceRoot = DEFAULT_EVIDENCE_ROOT,
  maxFiles = DEFAULT_MAX_FILES_PER_RUN,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES
}) {
  const { logPaths, runDirs } = await discoverEvidenceSources({ repoRoot, cardId });

  const merged = {
    evidenceDir: path.join(repoRoot, evidenceRoot, cardId),
    promoted: [],
    skippedMissing: [],
    skippedTooLarge: [],
    skippedOverCap: [],
    unchanged: []
  };

  for (const logPath of logPaths) {
    for (const runDir of runDirs) {
      const remaining = maxFiles - merged.promoted.length;
      if (remaining <= 0) break;
      const result = await promoteEvidence({
        repoRoot,
        cardId,
        runDir,
        logPath,
        evidenceRoot,
        maxFiles: remaining,
        maxFileBytes
      });
      merged.promoted.push(...result.promoted);
      merged.skippedMissing.push(...result.skippedMissing);
      merged.skippedTooLarge.push(...result.skippedTooLarge);
      merged.skippedOverCap.push(...result.skippedOverCap);
      merged.unchanged.push(...result.unchanged);
    }
  }

  return merged;
}

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
    if ((await fileSize(existingSamePath)) !== null) {
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
