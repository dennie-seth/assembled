#!/usr/bin/env node
/**
 * T-0384: the WSL-native replacement for the external `nightly-infra-prep` scheduled task (which
 * runs in a cloud sandbox with no WSL, and so cannot reach `~/dev/assembled-board` or the board
 * API directly). Run natively here, this has full git and API access, so it can implement every
 * vetting rule for real instead of coin-flipping on a browser-JS fallback.
 *
 *   node tools/board/ops/vetAndReady.js            # dry run (default): writes nothing
 *   node tools/board/ops/vetAndReady.js --apply     # PATCHes status: ready on the readied cards
 *
 * It only ever writes `status: "ready"` on vetted cards -- never launches a run, never merges,
 * never deploys, never edits a card body. The board's own auto-launch poller picks a readied card
 * up on its next tick.
 *
 * Every I/O boundary (the board API, `git log`, the filesystem) is a parameter of
 * `runVetAndReady`, so `tools/board/test/ops/vetAndReady.test.js` can exercise the whole run
 * without a real network call, a real `git` process, or touching a real file. See
 * `tools/board/src/lib/vetAndReady.js` for the actual vetting rules.
 */
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_BOARD_PORT } from "../src/lib/agentCurlPolicy.js";
import { vetAndReady, READY_CAP, revalidateCandidate } from "../src/lib/vetAndReady.js";
import { formatReport } from "../src/lib/vetAndReadyReport.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ACTOR_HEADER_VALUE = "agent:vet-and-ready";

/** Reads flags/env into one config object. `--apply` is the only opt-in to writing anything. */
export function resolveConfig(env = process.env, argv = []) {
  const apply = argv.includes("--apply");
  const baseUrl = env.BOARD_BASE_URL || `http://127.0.0.1:${env.BOARD_PORT || DEFAULT_BOARD_PORT}`;
  const repoRoot = env.BOARD_REPO_ROOT ? path.resolve(env.BOARD_REPO_ROOT) : REPO_ROOT;
  // Codex review 2026-09-18, finding 4: BOARD_VET_READY_CAP could previously raise the cap above
  // READY_CAP (e.g. =10 let six clean candidates all ready in one run). It may only ever lower
  // the cap now -- clamped here AND, independently, inside vetAndReady() itself (the selection
  // boundary), so this ceiling holds even if a future caller skips resolveConfig entirely.
  const parsedCap = Number(env.BOARD_VET_READY_CAP);
  const cap = Number.isInteger(parsedCap) && parsedCap > 0 ? Math.min(parsedCap, READY_CAP) : READY_CAP;
  const logDir = env.BOARD_VET_LOG_DIR || path.join(os.homedir(), ".local", "state", "board-vet-and-ready");
  const baseBranch = env.BOARD_VET_BASE_BRANCH || "develop";
  return { apply, baseUrl, repoRoot, cap, logDir, baseBranch };
}

/** Plain, unfiltered `GET /api/tasks` -- every deployment supports this, T-0383 or not. */
export async function fetchTasks({ baseUrl, fetchImpl }) {
  const res = await fetchImpl(`${baseUrl}/api/tasks`);
  if (!res.ok) {
    throw new Error(`GET /api/tasks failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * `GET /api/poller` (T-0383). Degrades gracefully to a documented fallback -- never throws --
 * when the route 404s/errors (a board deployment that predates T-0383) or the request itself
 * fails (board unreachable on this particular call, even though `fetchTasks` above succeeded).
 */
export async function fetchPollerState({ baseUrl, fetchImpl }) {
  try {
    const res = await fetchImpl(`${baseUrl}/api/poller`);
    if (!res.ok) {
      return {
        available: false,
        note: `GET /api/poller returned ${res.status} ${res.statusText} -- likely a board deployment that predates T-0383`
      };
    }
    const data = await res.json();
    return { available: true, ...data };
  } catch (err) {
    return { available: false, note: `GET /api/poller unreachable: ${err.message}` };
  }
}

/** A term that names a repo path (a file extension at the end, or a directory separator). */
function looksLikePath(term) {
  return /\.[a-zA-Z0-9]{1,6}$/.test(term) || term.includes("/");
}

/**
 * Builds the injectable `gitLogGrep(term)` rule 2 (`vetAndReady.js`'s `mergedWorkCheck`) needs.
 *
 * Codex review 2026-09-18, finding 2: a message `--grep` can never find merged work that never
 * mentioned the card id in a commit message. When `term` looks like a path (see `looksLikePath`
 * above -- exactly what `extractAcceptancePaths` extracts from a card's own `## Acceptance`
 * section), this instead runs a path-scoped `git log -- <path>`: does *any* commit on the base
 * branch touch this path at all. That's existence-on-branch, a mechanical git primitive -- not
 * a read of the path's content or an interpretation of what the card's acceptance prose means.
 * A card-id-shaped term (no dot-extension, no slash) still gets the original message `--grep`.
 */
export function makeGitLogGrep({ repoRoot, baseBranch, execFileFn }) {
  return async function gitLogGrep(term) {
    const args = looksLikePath(term)
      ? ["-C", repoRoot, "log", baseBranch, "--oneline", "--", term]
      : ["-C", repoRoot, "log", baseBranch, "--oneline", "-i", `--grep=${term}`];
    const { stdout } = await execFileFn("git", args);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  };
}

/**
 * The only write this script ever performs: `PATCH status: "ready"` on one vetted card.
 *
 * `expectedStatus`, when given, is sent as `X-Board-Expected-Status` -- the board rejects the
 * write with 409 if the card's actual current status no longer matches by the time the write
 * happens (see httpApi.js's `handlePatchTask`, `StaleWriteError`). Codex review 2026-09-18,
 * finding 3: this is the server-enforced half of the pre-write safety check; `revalidateCandidate`
 * below is the client-side half that catches everything the status alone can't (eligibility
 * scope, dependencies, body markers).
 */
export async function applyReady({ baseUrl, id, fetchImpl, expectedStatus }) {
  const headers = { "Content-Type": "application/json", "X-Board-Actor": ACTOR_HEADER_VALUE };
  if (expectedStatus) headers["X-Board-Expected-Status"] = expectedStatus;
  const res = await fetchImpl(`${baseUrl}/api/tasks/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "ready" })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PATCH /api/tasks/${id} failed: ${res.status} ${res.statusText}${text ? ` -- ${text}` : ""}`);
  }
  return res.json();
}

/**
 * Writes `status: ready` on every readied card -- but not blindly off the selection-time
 * snapshot. Codex review 2026-09-18, finding 3: the poller fetch and the per-candidate `git log`
 * calls that already happened this run are enough time for a card to change underneath it (a
 * human drags it, another process writes it, a dependency finishes). Before each write:
 *
 *   1. Re-fetch the full task list fresh (one call, not one per candidate).
 *   2. `revalidateCandidate` the entry against that fresh snapshot -- status, eligibility scope,
 *      dependencies, body markers all re-checked.
 *   3. Only if that still passes, PATCH with the freshly-observed status as
 *      `X-Board-Expected-Status`, so the board itself refuses a write that goes stale in the
 *      remaining gap between this re-check and the PATCH actually landing.
 *
 * If the initial re-fetch itself fails, nothing is written at all -- same "uncertainty means
 * backlog" posture as every other rule here.
 */
async function applyReadiedCards({ result, baseUrl, fetchImpl }) {
  if (result.readied.length === 0) {
    return "Apply mode -- nothing to write, zero cards were readied this run.";
  }

  let freshTasks;
  try {
    freshTasks = await fetchTasks({ baseUrl, fetchImpl });
  } catch (err) {
    return `Apply mode -- FAILED to re-fetch tasks for the pre-write revalidation, wrote nothing: ${err.message}`;
  }
  const freshById = new Map(freshTasks.map((task) => [task.id, task]));

  const outcomes = [];
  for (const entry of result.readied) {
    const freshTask = freshById.get(entry.id);
    const revalidation = revalidateCandidate(freshTask, freshById);
    if (!revalidation.ok) {
      outcomes.push(`${entry.id}: SKIPPED at write time -- ${revalidation.reason}`);
      continue;
    }
    try {
      await applyReady({ baseUrl, id: entry.id, fetchImpl, expectedStatus: freshTask.status });
      outcomes.push(`${entry.id}: wrote status=ready`);
    } catch (err) {
      outcomes.push(`${entry.id}: SKIPPED -- write refused (card changed): ${err.message}`);
    }
  }
  return `Apply mode:\n${outcomes.map((line) => `- ${line}`).join("\n")}`;
}

/**
 * Runs one full vet-and-ready pass: fetch tasks, read poller state, decide, print + persist the
 * report, and (only in apply mode) write `status: ready` on the readied cards. Every dependency
 * defaults to the real implementation so `node ops/vetAndReady.js` just works; tests override
 * them all to stay fully offline.
 */
export async function runVetAndReady({
  env = process.env,
  argv = [],
  fetchImpl,
  execFileFn,
  writeFileFn = fs.writeFile,
  mkdirFn = fs.mkdir,
  appendFileFn = fs.appendFile,
  now = () => new Date(),
  logFn = console.log
}) {
  const config = resolveConfig(env, argv);
  const timestamp = now().toISOString();

  let tasks;
  try {
    tasks = await fetchTasks({ baseUrl: config.baseUrl, fetchImpl });
  } catch (err) {
    logFn(`assembled-board vet-and-ready: FAILED to reach the board API at ${config.baseUrl}: ${err.message}`);
    return { exitCode: 1, config, timestamp };
  }

  const poller = await fetchPollerState({ baseUrl: config.baseUrl, fetchImpl });
  const gitLogGrep = makeGitLogGrep({ repoRoot: config.repoRoot, baseBranch: config.baseBranch, execFileFn });
  const result = await vetAndReady({ tasks, gitLogGrep, cap: config.cap });

  const appliedSummary = config.apply
    ? await applyReadiedCards({ result, baseUrl: config.baseUrl, fetchImpl })
    : "Dry run (default) -- nothing was written. Pass --apply to PATCH status: ready on the readied cards above.";

  const report = formatReport({ result, poller, timestamp, appliedSummary });
  logFn(report);

  try {
    await mkdirFn(config.logDir, { recursive: true });
    await writeFileFn(path.join(config.logDir, "latest.md"), report, "utf8");
    await appendFileFn(
      path.join(config.logDir, "history.log"),
      `${timestamp} readied=${result.readied.length} skipped=${result.skipped.length} apply=${config.apply}\n`,
      "utf8"
    );
  } catch (err) {
    logFn(`assembled-board vet-and-ready: could not write the summary file under ${config.logDir}: ${err.message}`);
  }

  return { exitCode: 0, config, timestamp, result, poller, report };
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const execFileFn = promisify(execFileCb);
  runVetAndReady({
    env: process.env,
    argv: process.argv.slice(2),
    fetchImpl: fetch,
    execFileFn
  }).then((result) => {
    process.exitCode = result.exitCode;
  });
}
