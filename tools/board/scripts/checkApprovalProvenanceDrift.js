#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { openDb } from "../src/lib/db/connection.js";
import { DbTaskStore } from "../src/lib/db/dbTaskStore.js";
import { findApprovalDrift } from "../src/lib/approvalProvenanceDrift.js";
import { collectAddedLines } from "../src/lib/gitAddedLines.js";
import { readApprovalLedger, mergeTasksWithLedger, ledgerAgeDays } from "../src/lib/approvalLedger.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// BOARD_TASKS_DIR: same override the live server (`src/server/index.js`) honors -- lets an
// end-to-end test point this script at a fixture tasks/ directory instead of the real repo's.
const TASKS_DIR = process.env.BOARD_TASKS_DIR || path.join(REPO_ROOT, "tasks");
const DEFAULT_PROVENANCE_PATH = path.join(REPO_ROOT, "ASSET_PROVENANCE.md");
// Committed snapshot of the board's approval record. Consulted ONLY for ids the live
// task store cannot resolve -- see approvalLedger.js for why CI needs it at all.
const LEDGER_PATH = process.env.BOARD_APPROVAL_LEDGER || path.join(REPO_ROOT, "tools", "board", "approval-ledger.json");
// T-0313: `LEDGER_STALE_DAYS` (14) only ever printed a WARNING, so a ledger stale for three days
// decided a fail-closed gate three separate times (five T-0274 runs, T-0306's dead escalation,
// `develop` red on every PR since #345) before anyone read the warning line. Ledger regeneration
// now runs on every PASS (runOrchestrator.js's `_handlePass`), so under normal throughput the
// committed ledger is at most a few hours old; a threshold measured in hours -- not a fortnight --
// actually catches "regeneration stopped happening" instead of comfortably tolerating it for two
// weeks. 24h gives a full day of runner downtime (nights, a quiet weekend) before this fires.
const LEDGER_STALE_HOURS = Number(process.env.BOARD_APPROVAL_LEDGER_STALE_HOURS || 24);

/**
 * CI-enforced backstop for T-0286 (docs/decision-log.md DL-27): `approvalVerdict` made the board
 * the single approval source of truth, but nothing previously caught `ASSET_PROVENANCE.md`'s own
 * prose sitting stale for days the way T-0257's did (approved on the board 2026-08-30, provenance
 * row still read "Not yet approved," blocking T-0243/T-0244/T-0245/T-0246 on a decision already
 * made). Deliberately independent of any agent's own tool grants -- this is a static, git-only
 * read (task files + the committed provenance file), run by CI on every PR that touches either,
 * so the drift is caught mechanically on the next push rather than by a human noticing.
 */
async function loadLiveTasks() {
  if ((process.env.BOARD_TASK_STORE || "fs") === "db") {
    const db = openDb();
    try {
      return await new DbTaskStore(db).list();
    } finally {
      db.close();
    }
  }
  return new FsTaskStore(TASKS_DIR).list();
}

/** Names the ledger's path, `generated_at`, and its age at read time -- so a refusal never makes a reader re-derive that from timestamps by hand. */
function describeLedgerSource(ledgerPath, ledger, ageHours) {
  const generatedAt = ledger?.generated_at ?? "unknown";
  const ageDisplay = Number.isFinite(ageHours) ? `${ageHours.toFixed(1)}h old` : "age unknown";
  return `${ledgerPath} (generated_at=${generatedAt}, ${ageDisplay})`;
}

/**
 * Live store first, committed ledger only for what it could not resolve.
 *
 * On the board the db is reachable and authoritative, so the ledger never overrides it and a
 * stale snapshot cannot mask real board state. In CI the live store resolves nothing past
 * T-0222, so the ledger supplies the approval record and the gate performs a REAL check rather
 * than failing closed on every provenance PR (the #315 case).
 *
 * If neither source resolves an id, nothing here papers over it: `findApprovalDrift` still
 * reports `unverifiable-approval-claim` and the gate still fails. "Couldn't check" never
 * becomes "passed" (T-0286, DL-27).
 *
 * @returns {Promise<{tasks: Array<object>, staleAndLoadBearing: boolean, loadBearing: boolean,
 *   sourceDescription: string|null}>} `staleAndLoadBearing` is true only when the ledger both
 *   exceeded `LEDGER_STALE_HOURS` AND actually filled in at least one id the live store could not
 *   resolve on its own (T-0313) -- "a stale ledger nobody read is not an error; a stale ledger
 *   deciding a gate is." The caller fails the whole run on this, independent of whatever
 *   `findApprovalDrift` itself finds. `loadBearing`/`sourceDescription` let the caller name the
 *   ledger's path/generated_at/age alongside an ordinary drift refusal too (T-0313 run-1 review:
 *   that path printed neither, even when the ledger supplied the very id in question).
 */
async function loadAllTasks() {
  const live = await loadLiveTasks();
  let ledger = null;
  try {
    ledger = await readApprovalLedger(LEDGER_PATH);
  } catch (err) {
    console.error(`approval ledger at ${LEDGER_PATH} is unreadable: ${err.message}`);
    return { tasks: live, staleAndLoadBearing: false, loadBearing: false, sourceDescription: null };
  }
  if (!ledger) {
    console.error(
      `approval ledger not found at ${LEDGER_PATH} -- ids the live task store cannot resolve ` +
        `will report as unverifiable. Regenerate with: node tools/board/scripts/exportApprovalLedger.js`
    );
    return { tasks: live, staleAndLoadBearing: false, loadBearing: false, sourceDescription: null };
  }

  // A `generated_at` in the future (clock skew) must never read as "extra fresh" -- that would
  // let an untrustworthy timestamp bypass the very staleness check it exists to trip. Treat it as
  // maximally stale instead, the same fail-closed direction as an unparseable timestamp.
  const rawAgeDays = ledgerAgeDays(ledger);
  const ageDays = rawAgeDays < 0 ? Infinity : rawAgeDays;
  const ageHours = ageDays * 24;
  const stale = ageHours > LEDGER_STALE_HOURS;
  const sourceDescription = describeLedgerSource(LEDGER_PATH, ledger, ageHours);

  const { tasks, filledFromLedger } = mergeTasksWithLedger(live, ledger);
  const loadBearing = filledFromLedger > 0;
  if (loadBearing) {
    console.log(
      `approval ledger supplied ${filledFromLedger} card(s) the live task store could not resolve -- ${sourceDescription}.`
    );
  }

  if (stale && loadBearing) {
    console.error(
      `FAILING: approval ledger is stale AND load-bearing -- ${sourceDescription} ` +
        `supplied ${filledFromLedger} card(s) the live task store could not resolve on its own, but is older ` +
        `than the ${LEDGER_STALE_HOURS}h freshness threshold (BOARD_APPROVAL_LEDGER_STALE_HOURS). A stale ` +
        `snapshot deciding a gate is the exact T-0273 incident (five T-0274 runs, T-0306's dead escalation, ` +
        `develop red since #345) -- regenerate it on the board with: node tools/board/scripts/exportApprovalLedger.js`
    );
    return { tasks, staleAndLoadBearing: true, loadBearing, sourceDescription };
  }

  if (stale) {
    console.error(
      `WARNING: approval ledger is stale -- ${sourceDescription} -- but supplied ` +
        `nothing the live task store could not already resolve on its own; not load-bearing, not failing.`
    );
  }

  return { tasks, staleAndLoadBearing: false, loadBearing, sourceDescription };
}

async function main() {
  const provenancePath = process.argv[2] || DEFAULT_PROVENANCE_PATH;
  const baseRef = process.argv[3] || "develop";
  // BOARD_GIT_CWD: lets an end-to-end test point the git-diff scoping at a fixture repo instead
  // of this real checkout -- mirrors BOARD_TASKS_DIR's override pattern above.
  const gitCwd = process.env.BOARD_GIT_CWD || REPO_ROOT;

  let provenanceText;
  try {
    provenanceText = await fs.readFile(provenancePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log(`${provenancePath}: no such file -- nothing to check.`);
      return;
    }
    throw err;
  }

  const { tasks, staleAndLoadBearing, loadBearing, sourceDescription } = await loadAllTasks();
  if (staleAndLoadBearing) {
    // Message already printed inside loadAllTasks (source path, generated_at, age). A stale
    // snapshot that was actually load-bearing means the merged task list can't be trusted, so
    // there is no value in still running the prose-drift check against it.
    process.exitCode = 1;
    return;
  }
  // Scopes the loud unresolvable-card-reference drift kind to lines this diff actually adds
  // (see approvalProvenanceDrift.js's `newLines` docstring) -- null (can't compute the diff, e.g.
  // baseRef doesn't exist) falls back to that check's original silent-skip behavior; the other
  // two drift kinds are unaffected either way, since they only ever fire on a genuine board-vs-
  // prose contradiction, not on missing data.
  const relativeProvenancePath = path.relative(gitCwd, provenancePath);
  const newLines = await collectAddedLines({ cwd: gitCwd, baseRef, file: relativeProvenancePath });
  const report = findApprovalDrift({ provenanceText, tasks, newLines });

  if (report.ok) {
    console.log(
      `Approval provenance drift check passed against ${provenancePath} (${tasks.length} task(s) cross-checked).`
    );
    return;
  }

  console.error(`Approval provenance drift FAILED against ${provenancePath}: ${report.drifts.length} issue(s).\n`);
  // T-0313 run-1 review: a load-bearing ledger's path/generated_at/age were only ever printed on
  // the two staleness branches above -- the ordinary refusal below (the exact
  // `unsubstantiated-approved-claim`/`unverifiable-approval-claim` shape that cost three separate
  // incidents) said nothing about the snapshot deciding it, forcing a reader to re-derive its age
  // from a bare timestamp by hand every time.
  if (loadBearing && sourceDescription) {
    console.error(`  approval ledger used: ${sourceDescription}\n`);
  }
  for (const drift of report.drifts) {
    console.error(`  ${drift.taskId} (${drift.kind}): ${drift.message}`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
