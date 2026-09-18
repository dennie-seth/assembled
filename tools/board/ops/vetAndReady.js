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
import { hashBody } from "../src/lib/taskStore.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ACTOR_HEADER_VALUE = "agent:vet-and-ready";

/**
 * Exit codes this CLI can return, named so both this file and the systemd unit notes (see
 * `ops/README.md`) refer to the same values instead of a bare magic number.
 *
 * T-0384 FIX ROUND 3 (reviewer FAIL round, 2026-09-18): before this, EVERY run that reached the
 * task fetch returned 0 -- including an apply-mode run where every single candidate was refused
 * at write time (a vetted-field change, a stale-write refusal, or a changed-card skip caught
 * immediately before the PATCH). That's the exact "reports success and exits 0" false-success
 * shape Codex's P2 #1 objected to, just moved from the write path to the exit code. `1` stays
 * reserved for "board API unreachable" (unchanged); `WRITE_REFUSED` is a distinct, new value so
 * the two failure modes are never confused by anything watching this process's exit status.
 * Dry runs and ordinary selection-time skips (dependency/merged-work/held/approval/GPU-asset/cap)
 * are not write-time events and always exit `OK`.
 */
export const EXIT_CODE_OK = 0;
export const EXIT_CODE_BOARD_UNREACHABLE = 1;
export const EXIT_CODE_WRITE_REFUSED = 2;

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
 * Builds the `X-Board-Expected-Fields` payload from a freshly-observed task snapshot: every field
 * this job's own rules vet, so the server-side write is conditioned on the WHOLE fingerprint --
 * never status alone. `body` is fingerprinted via `hashBody` rather than sent literally: a card
 * body can be many KB (this very card's is), far past what's reasonable to put in an HTTP header.
 *
 * T-0384 FIX ROUND 2 (Codex P2 #1, head d81d474c): before this, `applyReady` only ever sent
 * `X-Board-Expected-Status`, so a body/agent/deliverable_type/depends_on change landing between
 * this job's own check and the write (even one just a network round-trip away) was invisible to
 * the server-side precondition -- a card could be "readied" straight over a Held marker.
 */
function buildExpectedFields(task) {
  return {
    status: task.status,
    agent: task.agent,
    deliverable_type: task.deliverable_type ?? "code",
    requires_approval: task.requires_approval === true,
    depends_on: task.depends_on ?? [],
    bodyHash: hashBody(task.body)
  };
}

/**
 * The only write this script ever performs: `PATCH status: "ready"` on one vetted card.
 *
 * `expectedTask`, when given, is the freshest full snapshot of the card this job has (normally
 * fetched immediately before this call -- see `applyReadiedCards` below). It's sent as BOTH
 * `X-Board-Expected-Status` (for readability/back-compat) and `X-Board-Expected-Fields` -- a
 * fingerprint covering every field this job vetted. The board rejects the write with 409 if ANY
 * of them no longer match by the time the write happens (see httpApi.js's `handlePatchTask`,
 * `StaleWriteError`). Codex review 2026-09-18, finding 3: this is the server-enforced half of the
 * pre-write safety check; `revalidateCandidate` below is the client-side half that catches
 * everything a field fingerprint alone can't (eligibility scope, dependencies).
 */
export async function applyReady({ baseUrl, id, fetchImpl, expectedTask }) {
  const headers = { "Content-Type": "application/json", "X-Board-Actor": ACTOR_HEADER_VALUE };
  if (expectedTask) {
    headers["X-Board-Expected-Status"] = expectedTask.status;
    headers["X-Board-Expected-Fields"] = JSON.stringify(buildExpectedFields(expectedTask));
  }
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
 * snapshot, and not off one shared snapshot for the whole batch either. Codex review 2026-09-18,
 * finding 3 (and its FIX ROUND 2 follow-up, P2 #1, head d81d474c): the poller fetch, the
 * per-candidate `git log` calls, and every earlier candidate's own write in this same apply loop
 * are all enough time for a LATER card to change underneath it (a human drags it, another process
 * writes it, a dependency finishes) -- a single fetch shared across the whole loop only catches
 * changes that happened before that one fetch, not ones that land while the loop is still working
 * through earlier candidates. So for EACH candidate, immediately before its own write:
 *
 *   1. Re-fetch the full task list fresh (one call per candidate, not once for the whole batch).
 *   2. `revalidateCandidate` the entry against that fresh snapshot -- status, eligibility scope,
 *      dependencies, body markers all re-checked.
 *   3. Only if that still passes, PATCH with the freshly-observed task as the expected condition
 *      (`applyReady`'s `expectedTask` -- status AND a fingerprint of every other vetted field), so
 *      the board itself refuses a write that goes stale in the remaining gap between this
 *      re-check and the PATCH actually landing, no matter which field changed.
 *
 * If any candidate's own re-fetch fails, that candidate alone is skipped and reported -- it does
 * not abort the rest of the batch, and it never writes anything for that candidate. Same
 * "uncertainty means backlog" posture as every other rule here.
 *
 * Returns `{ summary, writeRefused }` rather than a bare string (T-0384 FIX ROUND 3): `writeRefused`
 * is true whenever at least one candidate did NOT get written -- a re-fetch failure, a failed
 * pre-write revalidation, or a write the server itself refused -- so `runVetAndReady` can surface
 * that as a distinct exit code instead of the run looking identical to full success.
 */
async function applyReadiedCards({ result, baseUrl, fetchImpl }) {
  if (result.readied.length === 0) {
    return { summary: "Apply mode -- nothing to write, zero cards were readied this run.", writeRefused: false };
  }

  const outcomes = [];
  let writeRefused = false;
  for (const entry of result.readied) {
    let freshTasks;
    try {
      freshTasks = await fetchTasks({ baseUrl, fetchImpl });
    } catch (err) {
      outcomes.push(`${entry.id}: SKIPPED -- FAILED to re-fetch tasks for the pre-write revalidation: ${err.message}`);
      writeRefused = true;
      continue;
    }
    const freshById = new Map(freshTasks.map((task) => [task.id, task]));
    const freshTask = freshById.get(entry.id);
    const revalidation = revalidateCandidate(freshTask, freshById);
    if (!revalidation.ok) {
      outcomes.push(`${entry.id}: SKIPPED at write time -- ${revalidation.reason}`);
      writeRefused = true;
      continue;
    }
    try {
      await applyReady({ baseUrl, id: entry.id, fetchImpl, expectedTask: freshTask });
      outcomes.push(`${entry.id}: wrote status=ready`);
    } catch (err) {
      outcomes.push(`${entry.id}: SKIPPED -- write refused (card changed): ${err.message}`);
      writeRefused = true;
    }
  }
  return { summary: `Apply mode:\n${outcomes.map((line) => `- ${line}`).join("\n")}`, writeRefused };
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
    return { exitCode: EXIT_CODE_BOARD_UNREACHABLE, config, timestamp };
  }

  const poller = await fetchPollerState({ baseUrl: config.baseUrl, fetchImpl });
  const gitLogGrep = makeGitLogGrep({ repoRoot: config.repoRoot, baseBranch: config.baseBranch, execFileFn });
  const result = await vetAndReady({ tasks, gitLogGrep, cap: config.cap });

  let appliedSummary;
  let writeRefused = false;
  if (config.apply) {
    const applied = await applyReadiedCards({ result, baseUrl: config.baseUrl, fetchImpl });
    appliedSummary = applied.summary;
    writeRefused = applied.writeRefused;
  } else {
    appliedSummary = "Dry run (default) -- nothing was written. Pass --apply to PATCH status: ready on the readied cards above.";
  }

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

  // Only an apply-mode write-time refusal changes the exit code -- a dry run and an ordinary
  // selection-time skip (dependency/merged-work/held/approval/GPU-asset/cap) are not write-time
  // events and must stay EXIT_CODE_OK so the systemd unit reads a legitimately-all-skipped dry
  // run as success.
  const exitCode = config.apply && writeRefused ? EXIT_CODE_WRITE_REFUSED : EXIT_CODE_OK;
  return { exitCode, config, timestamp, result, poller, report };
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
