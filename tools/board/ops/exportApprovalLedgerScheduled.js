#!/usr/bin/env node
/**
 * T-0434: the missing half of the fix for `checkApprovalProvenanceDrift.js` blocking #440 (ledger
 * 46h old) and #439 (62.9h old) on two consecutive days. `tools/board/approval-ledger.json` was
 * regenerated only by hand, or incidentally by `approvalLedgerRegen.js` inside `_handlePass` --
 * and that regeneration only runs on a PASS, writes into THAT card's own worktree, and skips the
 * write whenever the cards are unchanged (by design, to avoid a `generated_at`-only diff on every
 * unrelated PR). A quiet stretch on `develop` with no approval-bearing PASS means nothing ever
 * refreshes the ledger `develop` actually carries, and it ages past the gate's own
 * `BOARD_APPROVAL_LEDGER_STALE_HOURS` (24h) exactly as it did on #440/#439.
 *
 * This is a scheduled, host-side job (see `ops/board-ledger-export.sh` and
 * `ops/systemd/board-ledger-export.{service,timer}`) that runs directly against the `develop`
 * checkout: it re-runs the existing, unchanged `tools/board/scripts/exportApprovalLedger.js`
 * with `BOARD_TASK_STORE=db` (the live board's own mode -- committed `tasks/*.md` stops at
 * T-0365), and commits + pushes the result using the "refresh-before-it-bites" policy in
 * `src/lib/approvalLedgerScheduleDecision.js` -- commit when the cards changed, OR when the
 * committed ledger is already older than a threshold well under the gate's 24h, so the ledger can
 * never reach that threshold while this job is actually running (see that module's own specs for
 * the worked timeline).
 *
 *   node tools/board/ops/exportApprovalLedgerScheduled.js
 *
 * Every I/O boundary (git, the filesystem, the exporter subprocess) is a parameter of
 * `runLedgerExport`, so `test/ops/exportApprovalLedgerScheduled.test.js` exercises the whole run
 * without touching a real repo.
 */
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { decideLedgerExport, DEFAULT_REFRESH_THRESHOLD_HOURS } from "../src/lib/approvalLedgerScheduleDecision.js";
import { APPROVAL_LEDGER_RELATIVE_PATH } from "../src/runner/approvalLedgerRegen.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * `OK` covers every deliberate skip (wrong branch, dirty tree, not in sync with the remote, fresh
 * enough already) as well as a clean commit -- none of those are failures, and a systemd oneshot
 * unit should only read this job as failed when something actually went wrong. `EXPORT_FAILED`
 * is the exporter subprocess itself failing (commonly: the task store/DB was unreachable) or
 * producing an empty/invalid ledger -- caught before anything is ever written over the real file.
 * `GIT_FAILED` is a git operation this job needed failing: the fetch, or -- after a commit has
 * already landed locally -- the push.
 */
export const EXIT_CODE_OK = 0;
export const EXIT_CODE_EXPORT_FAILED = 1;
export const EXIT_CODE_GIT_FAILED = 2;

/** Reads env into one config object. */
export function resolveConfig(env = process.env) {
  const repoRoot = env.BOARD_REPO_ROOT ? path.resolve(env.BOARD_REPO_ROOT) : REPO_ROOT;
  const branch = env.BOARD_LEDGER_EXPORT_BRANCH || "develop";
  const remote = env.BOARD_LEDGER_EXPORT_REMOTE || "origin";
  const parsedThreshold = Number(env.BOARD_LEDGER_REFRESH_THRESHOLD_HOURS);
  const refreshThresholdHours = Number.isFinite(parsedThreshold) && parsedThreshold > 0
    ? parsedThreshold
    : DEFAULT_REFRESH_THRESHOLD_HOURS;
  const logDir = env.BOARD_LEDGER_EXPORT_LOG_DIR || path.join(os.homedir(), ".local", "state", "board-ledger-export");
  // The live board runs BOARD_TASK_STORE=db; committed tasks/*.md stops at T-0365. Default to
  // "db" here -- the opposite of exportApprovalLedger.js's own "fs" default -- so a scheduled
  // run reads the board's real state unless an operator explicitly overrides it.
  const taskStoreKind = env.BOARD_TASK_STORE || "db";
  return {
    repoRoot,
    branch,
    remote,
    refreshThresholdHours,
    logDir,
    taskStoreKind,
    ledgerRelativePath: APPROVAL_LEDGER_RELATIVE_PATH
  };
}

const EXPORTER_RELATIVE_PATH = path.join("tools", "board", "scripts", "exportApprovalLedger.js");

async function git(execFileFn, repoRoot, args) {
  return execFileFn("git", ["-C", repoRoot, ...args]);
}

// Every card's actual implementation work happens in its own checkout under worktrees/, never
// in this shared one -- but worktrees/ itself is NOT gitignored (no pattern in .gitignore or
// info/exclude covers it), and the cache under it persists even with no card running, so
// `git status --porcelain` always reports `?? worktrees/` here whether or not anything is
// actually in flight. Reading that line as foreign dirt made every real run skip forever; it is
// the repo's own structural layout, not evidence of in-progress work in THIS checkout.
const IGNORED_UNTRACKED_PREFIXES = ["worktrees/"];

/** `git status --porcelain` lines whose path is NOT the ledger -- "something else is dirty." */
function findForeignDirtyPaths(statusStdout, ledgerRelativePath) {
  return statusStdout
    .split("\n")
    .filter(Boolean)
    .filter((line) => line.slice(3).trim() !== ledgerRelativePath)
    .filter((line) => !IGNORED_UNTRACKED_PREFIXES.some((prefix) => line.slice(3).trim().startsWith(prefix)));
}

function ledgerAgeHoursOf(ledger, now) {
  if (!ledger || typeof ledger.generated_at !== "string") return Infinity;
  const generatedAtMs = Date.parse(ledger.generated_at);
  if (Number.isNaN(generatedAtMs)) return Infinity;
  const ageMs = now().getTime() - generatedAtMs;
  // A future generated_at (clock skew) must never read as "extra fresh" -- same fail-closed
  // direction checkApprovalProvenanceDrift.js already takes for the same condition.
  if (ageMs < 0) return Infinity;
  return ageMs / 3_600_000;
}

/** Reads a JSON file, or `null` on ENOENT. Any other read/parse error propagates. */
async function readJsonOrNull(readFileFn, filePath) {
  let raw;
  try {
    raw = await readFileFn(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(raw);
}

/**
 * Reads the ledger as last COMMITTED (`git show HEAD:<path>`), never the working-tree file --
 * the preflight above deliberately allows the ledger file itself to be dirty (a prior export's
 * tmp-rename, or a human mid-edit), so an uncommitted-but-fresh copy sitting on a stale HEAD must
 * never be read as "already fresh". `git show` failing (most commonly: the path doesn't exist at
 * HEAD yet, e.g. the very first run) is treated as "no committed ledger", the same fail-toward-
 * refresh direction `readJsonOrNull`'s ENOENT case already takes.
 */
async function defaultReadCommittedLedger(execFileFn, repoRoot, ledgerRelativePath) {
  let stdout;
  try {
    ({ stdout } = await git(execFileFn, repoRoot, ["show", `HEAD:${ledgerRelativePath}`]));
  } catch {
    return null;
  }
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function writeSummary({ mkdirFn, writeFileFn, appendFileFn, logDir, timestamp, summary, logFn }) {
  logFn(summary);
  try {
    await mkdirFn(logDir, { recursive: true });
    await writeFileFn(path.join(logDir, "latest.log"), summary, "utf8");
    await appendFileFn(path.join(logDir, "history.log"), `${timestamp} ${summary.split("\n")[0]}\n`, "utf8");
  } catch (err) {
    logFn(`board-ledger-export: could not write the summary under ${logDir}: ${err.message}`);
  }
}

/**
 * One full run: branch/clean/in-sync preflight, export to a temp file, decide, and -- only when
 * the decision says so -- atomically replace the committed ledger, commit, and push.
 *
 * Every dependency defaults to the real implementation so `node
 * ops/exportApprovalLedgerScheduled.js` just works; tests override them all to stay fully offline.
 */
export async function runLedgerExport({
  env = process.env,
  execFileFn,
  readFileFn = fs.readFile,
  renameFn = fs.rename,
  unlinkFn = fs.unlink,
  mkdirFn = fs.mkdir,
  writeFileFn = fs.writeFile,
  appendFileFn = fs.appendFile,
  readCommittedLedgerFn = defaultReadCommittedLedger,
  now = () => new Date(),
  logFn = console.log
}) {
  const config = resolveConfig(env);
  const timestamp = now().toISOString();
  const ledgerAbsPath = path.join(config.repoRoot, config.ledgerRelativePath);

  async function finish(exitCode, reason, extraLines = []) {
    const summary = [`board-ledger-export ${timestamp}: ${reason}`, ...extraLines].join("\n");
    await writeSummary({ mkdirFn, writeFileFn, appendFileFn, logDir: config.logDir, timestamp, summary, logFn });
    return { exitCode, reason, config, timestamp };
  }

  const currentBranch = (await git(execFileFn, config.repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  if (currentBranch !== config.branch) {
    return finish(EXIT_CODE_OK, "wrong-branch", [
      `checkout is on '${currentBranch}', not the target branch '${config.branch}' -- skipping.`
    ]);
  }

  const statusStdout = (await git(execFileFn, config.repoRoot, ["status", "--porcelain"])).stdout;
  const foreignDirty = findForeignDirtyPaths(statusStdout, config.ledgerRelativePath);
  if (foreignDirty.length > 0) {
    return finish(EXIT_CODE_OK, "working-tree-dirty", [
      "the working tree has changes outside the ledger file -- a run or other work may be in",
      "progress, so this job will not commit over it. Dirty paths:",
      ...foreignDirty.map((line) => `  ${line}`)
    ]);
  }

  try {
    await git(execFileFn, config.repoRoot, ["fetch", config.remote, config.branch]);
  } catch (err) {
    return finish(EXIT_CODE_GIT_FAILED, "fetch-failed", [`git fetch ${config.remote} ${config.branch} failed: ${err.message}`]);
  }

  const localHead = (await git(execFileFn, config.repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const remoteHead = (await git(execFileFn, config.repoRoot, ["rev-parse", `${config.remote}/${config.branch}`])).stdout.trim();
  if (localHead !== remoteHead) {
    return finish(EXIT_CODE_OK, "not-in-sync-with-remote", [
      `local ${config.branch} (${localHead}) does not match ${config.remote}/${config.branch} (${remoteHead}) -- `,
      "skipping rather than merging automatically. The next run re-checks after a fresh fetch."
    ]);
  }

  const tmpPath = `${ledgerAbsPath}.tmp-${now().getTime()}`;
  // Scoped to this one try/finally so the temp file is removed on EVERY exit path out of the
  // block below -- a non-zero exporter exit, an unparseable/empty result, a skip, or a later
  // git failure -- not just the success path. A prior round deleted it only on two of the four
  // failure branches; the exporter-subprocess-failure branch left it behind, and the next tick
  // then read it as untracked working-tree dirt and skipped forever (self-perpetuating).
  // `tmpOwned` flips to false only once `renameFn` has actually moved it onto the real ledger
  // path, so the finally block never tries to unlink a path that no longer exists there.
  let tmpOwned = true;
  try {
    try {
      await execFileFn("node", [EXPORTER_RELATIVE_PATH, tmpPath], {
        cwd: config.repoRoot,
        env: { ...env, BOARD_TASK_STORE: config.taskStoreKind }
      });
    } catch (err) {
      return finish(EXIT_CODE_EXPORT_FAILED, "export-failed", [
        "the exporter subprocess failed -- this often means the task store (DB) was unreachable.",
        err.stderr || err.message
      ]);
    }

    let freshLedger;
    try {
      freshLedger = await readJsonOrNull(readFileFn, tmpPath);
    } catch (err) {
      return finish(EXIT_CODE_EXPORT_FAILED, "export-produced-empty-ledger", [`the exported tmp ledger was unreadable/invalid: ${err.message}`]);
    }
    if (!freshLedger || !Array.isArray(freshLedger.cards) || freshLedger.cards.length === 0) {
      return finish(EXIT_CODE_EXPORT_FAILED, "export-produced-empty-ledger", [
        "the exporter produced no cards -- refusing to touch the committed ledger."
      ]);
    }

    const existingLedger = await readCommittedLedgerFn(execFileFn, config.repoRoot, config.ledgerRelativePath);
    const cardsChanged = !existingLedger || JSON.stringify(existingLedger.cards) !== JSON.stringify(freshLedger.cards);
    const ledgerAgeHours = ledgerAgeHoursOf(existingLedger, now);
    const decision = decideLedgerExport({
      cardsChanged,
      ledgerAgeHours,
      refreshThresholdHours: config.refreshThresholdHours
    });

    if (!decision.shouldCommit) {
      return finish(EXIT_CODE_OK, decision.reason, [
        `committed ledger is ${Number.isFinite(ledgerAgeHours) ? `${ledgerAgeHours.toFixed(1)}h` : "age-unknown"} old, ` +
          `cards unchanged, threshold ${config.refreshThresholdHours}h -- nothing to do.`
      ]);
    }

    await renameFn(tmpPath, ledgerAbsPath);
    tmpOwned = false;
    try {
      await git(execFileFn, config.repoRoot, ["add", "--", config.ledgerRelativePath]);
      const cardCount = freshLedger.cards.length;
      const ageDisplay = Number.isFinite(ledgerAgeHours) ? `${ledgerAgeHours.toFixed(1)}h` : "no prior ledger";
      await git(execFileFn, config.repoRoot, [
        "commit",
        "-m",
        `[auto] refresh approval ledger (${cardCount} card(s), reason: ${decision.reason}, previous age: ${ageDisplay})\n\nAutomated-by: board-ledger-export.sh`
      ]);
    } catch (err) {
      return finish(EXIT_CODE_GIT_FAILED, "commit-failed", [`git add/commit failed: ${err.message}`]);
    }

    try {
      await git(execFileFn, config.repoRoot, ["push", config.remote, config.branch]);
    } catch (err) {
      return finish(EXIT_CODE_GIT_FAILED, "push-failed", [
        `the ledger refresh was committed locally but 'git push ${config.remote} ${config.branch}' failed: ${err.message}`,
        "the commit stays local; the next run's sync check will skip until this is resolved by hand."
      ]);
    }

    return finish(EXIT_CODE_OK, decision.reason, [`committed and pushed a refreshed ledger (${freshLedger.cards.length} card(s)).`]);
  } finally {
    if (tmpOwned) {
      await unlinkFn(tmpPath).catch(() => {});
    }
  }
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const execFileFn = promisify(execFileCb);
  runLedgerExport({ env: process.env, execFileFn }).then((result) => {
    process.exitCode = result.exitCode;
  });
}
