import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * T-0396: the shared per-attempt helper asset-generation cards use so a run id lands on every
 * committed frame automatically, and so committing that attempt's evidence is one mechanical
 * step instead of something left to agent discipline. T-0387 put all three of its attempts'
 * evidence into a single commit (22a2867); reviewers noted it but could not fail it -- the cap
 * was already spent, and a retry can't invent history after the fact. `recordAttempt` makes
 * that impossible by construction: one call per finished attempt, one commit, with the run id
 * (the board's `BOARD_RUN_ID`, the same id `tasks/.runs/<id>.jsonl` is named after) recorded in
 * both the attempt's provenance sidecar and its own attempt-log row.
 */

export class AttemptCommitError extends Error {}

/** The current board run's id from `BOARD_RUN_ID` in `env` (defaults to `process.env`), or `null` outside a board run (invoked by hand, or from a test). */
export function resolveRunId(env = process.env) {
  const value = env.BOARD_RUN_ID;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * One attempt-log row. `run_id` is always present -- explicit `null` when there is none, never
 * omitted and never fabricated, so a reader can always tell "no run id was recorded" from "this
 * row predates the run_id field".
 */
export function buildAttemptLogRow({ attempt, status, framePath = null, runId = null, now = () => new Date() }) {
  return {
    attempt,
    run_id: runId,
    status,
    frame_path: framePath ?? null,
    timestamp: now().toISOString()
  };
}

/** Appends one NDJSON attempt-log row, creating the parent directory and the file if needed. */
export async function appendAttemptLogRow(logPath, options) {
  const row = buildAttemptLogRow(options);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(row)}\n`, "utf8");
  return row;
}

/** Every row an attempt-log file holds, or `[]` if it does not exist yet. */
export async function readAttemptLog(logPath) {
  let raw;
  try {
    raw = await fs.readFile(logPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * `record` with `run_id` set to `runId` (`null` when absent) -- a prior `run_id` key on
 * `record` is discarded rather than trusted, the same "writer owns this field" idiom
 * `comfy_client.provenance_sidecar` already uses for its own `generator` field, so a caller
 * cannot smuggle a fake run id through the record it passes in.
 */
export function mergeRunIdIntoProvenance(record, runId) {
  const rest = { ...(record ?? {}) };
  delete rest.run_id;
  return { ...rest, run_id: runId ?? null };
}

/** Writes a `.provenance.json` sidecar with `run_id` merged in, pretty-printed with a trailing newline. */
export async function writeAttemptProvenance(sidecarPath, record, { runId = null } = {}) {
  const payload = mergeRunIdIntoProvenance(record, runId);
  await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
  await fs.writeFile(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

/**
 * `git add` + `git commit` exactly `paths` as one commit -- the mechanical half of per-attempt
 * commit cadence. Throws `AttemptCommitError` if there is nothing to commit or git itself fails,
 * rather than silently producing an empty or partial commit.
 */
export async function commitAttemptEvidence({ repoRoot, paths, message, runId = null }) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new AttemptCommitError(
      "commitAttemptEvidence called with no paths to commit -- nothing to commit for this attempt"
    );
  }
  try {
    await execFileAsync("git", ["add", "--", ...paths], { cwd: repoRoot });
  } catch (err) {
    throw new AttemptCommitError(`git add failed for ${paths.join(", ")}: ${err.message}`);
  }

  const fullMessage = runId ? `${message}\n\nRun-Id: ${runId}` : message;
  try {
    await execFileAsync("git", ["commit", "-m", fullMessage], { cwd: repoRoot });
  } catch (err) {
    throw new AttemptCommitError(`git commit failed for ${paths.join(", ")}: ${err.message}`);
  }

  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  return stdout.trim();
}

/**
 * Records one generation attempt: provenance (when a frame + sidecar path are given) + a
 * structured attempt-log row (always, even for a frame-less attempt) + -- unless `dryRun` --
 * that attempt's own evidence committed as ONE commit, distinct from every other attempt's.
 *
 * `runId` defaults to `resolveRunId()` (the environment's `BOARD_RUN_ID`) when omitted; pass an
 * explicit value, including `null`, to override. A `dryRun` performs no writes and no commits at
 * all, even when a run id is present. An attempt with no `framePath` still gets its attempt-log
 * row (with the run id), but writes no sidecar and commits no frame file that would misrepresent
 * output as existing.
 */
export async function recordAttempt({
  repoRoot,
  attempt,
  logPath,
  commitMessage,
  framePath = null,
  extraPaths = [],
  sidecarPath = null,
  sidecarRecord = null,
  dryRun = false,
  runId,
  now = () => new Date()
} = {}) {
  const resolvedRunId = runId === undefined ? resolveRunId() : runId;

  if (dryRun) {
    return { attempt, runId: resolvedRunId, committed: false, commitSha: null, frameCommitted: false, logRow: null };
  }

  if (framePath && sidecarPath) {
    await writeAttemptProvenance(sidecarPath, sidecarRecord ?? {}, { runId: resolvedRunId });
  }

  const status = framePath ? "completed" : "no_frame";
  const logRow = await appendAttemptLogRow(logPath, { attempt, status, framePath, runId: resolvedRunId, now });

  const commitPaths = [...extraPaths, logPath];
  const frameCommitted = Boolean(framePath);
  if (frameCommitted) commitPaths.push(framePath);
  if (sidecarPath && framePath) commitPaths.push(sidecarPath);

  const commitSha = await commitAttemptEvidence({
    repoRoot,
    paths: commitPaths,
    message: commitMessage,
    runId: resolvedRunId
  });

  return { attempt, runId: resolvedRunId, committed: true, commitSha, frameCommitted, logRow };
}
