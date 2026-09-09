import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Per-card archive for reviewer verdicts (T-0345). Before this, every VALIDATION round's
 * FAIL/PASS notes were appended straight into the task card's own body (runOrchestrator.js's
 * old appendNote-based history) -- unbounded growth that's also the agent's own prompt, since
 * promptBuilder.js injects the body verbatim. A card with enough rounds crossed Linux's argv
 * size limit outright (`spawn E2BIG`, T-0243) even after the prompt was moved off argv onto
 * stdin; more routinely, it just re-fed every prior round's full text back into every
 * subsequent implementer/reviewer run. This module moves that text out to a side file per card
 * (mirroring the existing tasks/attachments/<id>/ and tasks/.runs/<id>/ conventions) and
 * provides a deterministic digest for the prompt to carry forward instead.
 */

const ARCHIVE_DIR_NAME = ".verdicts";

export function verdictArchiveDir(tasksDir) {
  return path.join(tasksDir, ARCHIVE_DIR_NAME);
}

export function verdictArchivePath(tasksDir, id) {
  return path.join(verdictArchiveDir(tasksDir), `${id}.jsonl`);
}

/** Appends one verdict entry ({heading, timestamp, text}) to a card's archive, in order. */
export async function appendVerdictEntry(tasksDir, id, entry) {
  await fs.mkdir(verdictArchiveDir(tasksDir), { recursive: true });
  const line = `${JSON.stringify(entry)}\n`;
  await fs.appendFile(verdictArchivePath(tasksDir, id), line, "utf8");
}

/** Reads a card's archived verdict entries, oldest first. Empty array if none exist yet. */
export async function readVerdictEntries(tasksDir, id) {
  let raw;
  try {
    raw = await fs.readFile(verdictArchivePath(tasksDir, id), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function truncateOneLine(text, max) {
  const collapsed = String(text).replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/**
 * Builds the short, deterministic summary handed to the agent's prompt in place of the full
 * verdict history: total FAIL/PASS counts (so the record isn't lost even beyond the window
 * below) plus the most recent `limit` entries, one line each, text collapsed to a single line
 * and capped. Pure function of its input -- no clock, no randomness -- so it's directly
 * testable and reproducible.
 */
export function buildVerdictDigest(entries, { limit = 5, maxTextLength = 240 } = {}) {
  if (!entries || entries.length === 0) return "";

  const failCount = entries.filter((e) => e.heading === "Validation: FAIL").length;
  const passCount = entries.filter((e) => e.heading === "Validation: PASS").length;
  const recent = entries.slice(-limit);
  const lines = recent.map(
    (e) => `- [${e.timestamp}] ${e.heading}: ${truncateOneLine(e.text, maxTextLength)}`
  );

  return [
    `${entries.length} prior validation verdict(s) archived: ${failCount} FAIL, ${passCount} PASS.`,
    `Most recent ${recent.length} (oldest to newest):`,
    ...lines
  ].join("\n");
}

const TOP_HEADING_RE = /^## (.+)$/gm;
const VERDICT_HEADING_RE = /^Validation: (FAIL|PASS) \(([^)]+)\)$/;

/** Splits a body into top-level `## heading` sections; each `raw` is an exact, order-preserving substring. */
function splitBodyIntoSections(body) {
  const matches = [...body.matchAll(TOP_HEADING_RE)];
  const sections = [];
  const firstStart = matches.length > 0 ? matches[0].index : body.length;
  if (firstStart > 0) {
    sections.push({ heading: null, raw: body.slice(0, firstStart) });
  }
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    sections.push({ heading: matches[i][1].trim(), raw: body.slice(start, end) });
  }
  return sections;
}

/** Strips a section's `## heading (ts)` line (and the one blank line after it, if present). */
function extractNoteText(raw) {
  const firstNewline = raw.indexOf("\n");
  if (firstNewline === -1) return "";
  let rest = raw.slice(firstNewline + 1);
  rest = rest.replace(/^\n/, "");
  return rest.replace(/\n*$/, "");
}

/**
 * Pulls every `## Validation: FAIL (ts)` / `## Validation: PASS (ts)` section out of a task
 * body -- the shape runOrchestrator.js's old appendNote always wrote -- into archive entries,
 * losslessly: each entry's `text` is exactly what was originally passed to appendNote, so
 * re-rendering it as `` `## ${heading} (${timestamp})\n\n${text}\n` `` reproduces the original
 * section byte-for-byte. Every other section (Context, Acceptance, PR, Blocked, human comments,
 * anything else) is left in place and in its original order. Idempotent: a body with nothing
 * left to archive comes back unchanged.
 */
export function migrateBodyVerdicts(body) {
  const sections = splitBodyIntoSections(body);
  const kept = [];
  const entries = [];

  for (const section of sections) {
    const match = section.heading && VERDICT_HEADING_RE.exec(section.heading);
    if (!match) {
      kept.push(section);
      continue;
    }
    entries.push({
      heading: `Validation: ${match[1]}`,
      timestamp: match[2],
      text: extractNoteText(section.raw)
    });
  }

  const newBody = kept.map((s) => s.raw).join("").replace(/\n{3,}$/, "\n\n");
  return { body: newBody, entries };
}
