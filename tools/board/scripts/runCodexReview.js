#!/usr/bin/env node
/**
 * T-0460: the spike's "board job" entry point. Plays the role runOrchestrator.js's _runPhase
 * plays for every other agent -- mint a run id, call AgentRunner.start/observe/kill, persist the
 * raw event stream to tasks/.runs/<runId>.jsonl via createRunLog (the exact same function
 * ClaudeCliRunner's caller uses) -- but for a CodexCliRunner instance instead of ClaudeCliRunner,
 * and ends by calling codexVerdictPublisher.js instead of runOrchestrator's own
 * _handlePass/_handleFailValidation. Wiring a real `agent: "codex-reviewer"` dispatch branch into
 * runOrchestrator.js's live dispatch table is deliberately NOT done here -- see
 * docs/design/codex-reviewer-adapter-spike.md's "what the next slice must still establish" -- a
 * spike should not change the production orchestrator's dispatch behavior for every other
 * already-running card. This script demonstrates the same AgentRunner contract stands ready to
 * be wired in as a small, mechanical follow-up at that one call site.
 *
 * FIX ROUND (Dennie, human comment (c)): the logic below is `runCodexReviewJob`, a plain
 * function with every side-effecting dependency injectable -- `main()` is now just a thin CLI
 * wrapper that reads env vars and calls it. This is what makes it testable with a mocked child
 * process rather than only by hand-running a real `codex` binary. Two liveness keys are used,
 * deliberately kept apart (see `reviewRunStateKey` below): the SUBJECT card's own
 * implementation runstate (`taskId`, read-only -- checked, never written) and this review job's
 * OWN runstate (`${taskId}.codex-review`, written and cleared by this script). The pre-fix
 * version wrote the review job's liveness under the bare `taskId` key -- the exact same key the
 * subject card's own implementer/reviewer phases use -- so running a review while the card's own
 * real run was active stomped that run's own pid out from under it, and a crash during the
 * review would leave orphanReaper.js reaping the SUBJECT CARD to `blocked` over a smoke-test
 * review job's death, not its own.
 *
 * Required env:
 *   CODEX_BIN    absolute path to the native codex binary this process will spawn
 *   CODEX_HOME   absolute path to the CODEX_HOME directory holding auth.json/config.toml
 * Optional env:
 *   CODEX_REVIEW_TIMEOUT_MS   wall-clock budget for the one review turn (default 600000 = 10 min)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexCliRunner, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_TOTAL_TOKENS } from "../src/runner/codexCliRunner.js";
import { extractCodexResult } from "../src/runner/codexResultExtractor.js";
import { publishCodexVerdict } from "../src/runner/codexVerdictPublisher.js";
import { createRunLog } from "../src/runner/runLog.js";
import { NdjsonEventParser } from "../src/runner/streamParser.js";
import { writeRunState, readRunState, clearRunState, isRunLive, isPidAlive } from "../src/runner/runState.js";
import {
  reserveLaunchSlot,
  releaseReservation,
  reservationLeasePath,
  DuplicateReservationError
} from "../src/runner/launchReservation.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function gitHead(cwd) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();
}

/**
 * This review job's OWN liveness key -- never the subject card's bare `taskId`. See this file's
 * header comment for why sharing that key was the bug.
 */
export function reviewRunStateKey(taskId) {
  return `${taskId}.codex-review`;
}

export function buildReviewPrompt({ taskId, reviewedSha, acceptanceCriteriaVersion, sprintId, jobId }) {
  return [
    "You are reviewing a git worktree, read-only, as a bounded spike demonstration of a Codex",
    "reviewer board job (card T-0460). Do not write, create, or modify any file.",
    "",
    `Confirm the current git HEAD equals exactly this SHA: ${reviewedSha} (run \`git rev-parse HEAD\`).`,
    "Then inspect tools/board/src/runner/codexCliRunner.js, codexVerdictPublisher.js, and",
    "codexVerdictSchema.js, and run `npx vitest run test/runner/codexCliRunner.test.js",
    "test/runner/codexVerdictPublisher.test.js test/runner/codexVerdictSchema.test.js",
    "test/runner/codexResultExtractor.test.js` from the tools/board directory as your check.",
    "",
    "Respond with EXACTLY ONE fenced ```json code block and nothing else outside it (no prose",
    "before or after). The JSON object must have exactly these fields:",
    "{",
    `  "job": {"jobId": "${jobId}", "ticketId": "${taskId}", "sprintId": "${sprintId}"},`,
    `  "reviewedSha": "<the 40-character hex SHA you confirmed, must equal ${reviewedSha}>",`,
    `  "acceptanceCriteriaVersion": "${acceptanceCriteriaVersion}",`,
    '  "outcome": "<exactly one of PASS, CHANGES_REQUESTED, BLOCKED>",',
    '  "findings": [{"file": "...", "line": 0, "evidence": "..."}],',
    '  "checksPerformed": ["..."],',
    '  "limitations": ["..."]',
    "}",
    "findings may be an empty array if you found nothing to flag. Use the exact job object given",
    "above verbatim -- do not invent your own jobId/ticketId/sprintId."
  ].join("\n");
}

/** The fixed (executionId, invocationId) launchReservation.js key for "one review in flight at a
 * time" per card -- `cardId` (the review job's own `reviewRunStateKey`) is what distinguishes one
 * card's slot from another's; these two never vary. */
export const REVIEW_SLOT_EXECUTION_ID = "codex-review";
export const REVIEW_SLOT_INVOCATION_ID = "lock";

/**
 * Atomically claims the single "one review in flight at a time" slot for `cardId` (the review
 * job's OWN reservation key, `reviewRunStateKey(taskId)` -- never the subject's bare taskId),
 * reusing launchReservation.js's own `link()`-based exclusivity (`reserveLaunchSlot`,
 * `DuplicateReservationError`) in place of the read-then-write runstate check this replaces (FIX
 * ROUND 2, human comment (b)): that guard read "not live" and only later wrote a runstate, with a
 * real window between the two where a second caller could read the identical "not live" answer
 * and also pass -- the kind of race `runCodexReview.js` could never close by itself. Two callers
 * racing to reserve the IDENTICAL `(cardId, executionId, invocationId)` key are arbitrated by the
 * filesystem's own atomic `link`, not by either caller's own bookkeeping; losing that race is a
 * real `EEXIST`, not a stale read.
 *
 * `launchReservation.js` never deletes a lease file itself (by design -- see its own docstring:
 * leases are an append-only ledger), so reusing the identical key for every review of this card
 * needs its own recycling step once a prior review has finished: on `DuplicateReservationError`,
 * the existing lease is read directly and reclaimed -- the stale file removed, then a single
 * retry -- when it is already marked `released`, or when its recorded owner `pid` is no longer
 * alive. The pid-liveness check is the same `isPidAlive` primitive every other recovery path in
 * this codebase already uses (`runState.js`, `codexVerdictPublisher.js`'s own claim recovery), so
 * a review that was killed outright -- not merely one that threw and released cleanly -- still
 * frees the slot for the next attempt rather than stranding the card behind a dead claim forever
 * (the card's own edge case: "state explicitly how the claim becomes reclaimable").
 */
export async function claimReviewSlot({
  runsDir,
  cardId,
  owner,
  reserveLaunchSlotFn = reserveLaunchSlot,
  readFileFn = (p) => fs.readFile(p, "utf8"),
  unlinkFn = fs.unlink,
  isPidAliveFn = isPidAlive,
  now = () => new Date()
}) {
  const executionId = REVIEW_SLOT_EXECUTION_ID;
  const invocationId = REVIEW_SLOT_INVOCATION_ID;

  // Bounded to two attempts: the first either succeeds outright or finds a lease to inspect; the
  // second only runs after that lease was proven stale and removed, so it either claims the now-
  // free slot or discovers a genuinely live concurrent claimant that won the removal-then-reclaim
  // race -- never a third generation within one call.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await reserveLaunchSlotFn({ runsDir, cardId, executionId, invocationId, owner, reservedCostUsd: 0, now });
      return { claimed: true, executionId, invocationId };
    } catch (err) {
      if (!(err instanceof DuplicateReservationError)) throw err;
      const leasePath = reservationLeasePath(runsDir, { cardId, executionId, invocationId });
      let existing;
      try {
        existing = JSON.parse(await readFileFn(leasePath));
      } catch {
        continue; // raced with a concurrent reclaim removing the lease -- retry the reserve
      }
      const ownerPid = existing.owner && typeof existing.owner.pid === "number" ? existing.owner.pid : null;
      const stillLive = existing.released !== true && ownerPid !== null && isPidAliveFn(ownerPid);
      if (stillLive) {
        return { claimed: false, reason: "review-already-in-flight", existing };
      }
      await unlinkFn(leasePath).catch(() => {});
    }
  }
  return { claimed: false, reason: "review-slot-contended" };
}

/**
 * Releases a review slot lease only when the CURRENT lease on disk is still the one `owner`
 * itself reserved (same pid) -- never a lease some other process now owns, whether a foreign
 * claim this process never held, or one reclaimed out from under a run that still thought it
 * owned it. A no-op (returns `null`) on any mismatch, rather than releasing someone else's claim.
 */
export async function releaseOwnedReviewSlot({
  runsDir,
  cardId,
  executionId,
  invocationId,
  owner,
  outcome,
  releaseReservationFn = releaseReservation,
  readFileFn = (p) => fs.readFile(p, "utf8")
}) {
  const leasePath = reservationLeasePath(runsDir, { cardId, executionId, invocationId });
  let existing;
  try {
    existing = JSON.parse(await readFileFn(leasePath));
  } catch {
    return null;
  }
  const ownerPid = existing.owner && typeof existing.owner.pid === "number" ? existing.owner.pid : null;
  if (ownerPid !== owner.pid) {
    return null;
  }
  return releaseReservationFn({ runsDir, cardId, executionId, invocationId, outcome });
}

/**
 * Publishes an immediate BLOCKED verdict for a precondition that refused to even start the
 * review -- reuses the publisher's own BLOCKED path (same as a real process failure) rather than
 * inventing a second "refused" shape the card could show.
 */
async function publishPreflightBlock({ tasksDir, taskId, jobId, sprintId, acceptanceCriteriaVersion, reviewedSha, reason, detail, publishCodexVerdictFn, gitHeadFn, worktreeDir }) {
  const currentHead = gitHeadFn(worktreeDir);
  return publishCodexVerdictFn({
    tasksDir,
    taskId,
    deliveryId: jobId,
    dispatchedJob: { jobId, ticketId: taskId, sprintId, dispatchedSha: reviewedSha, acceptanceCriteriaVersion },
    runResult: { kind: "process-failure", reason, detail },
    currentHead
  });
}

/**
 * The job itself, every side effect injectable. `main()` below supplies the real
 * CodexCliRunner/filesystem/git -- tests supply fakes for a mocked child process without
 * spawning `codex` at all.
 */
export async function runCodexReviewJob({
  taskId,
  worktreeDir,
  codexBin,
  codexHome,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxTotalTokens = DEFAULT_MAX_TOTAL_TOKENS,
  sprintId = "spike", // placeholder: no sprint scheduler exists yet, out of scope per this card's own Scope section
  acceptanceCriteriaVersion,
  gitHeadFn = gitHead,
  createRunLogFn = createRunLog,
  readRunStateFn = readRunState,
  isRunLiveFn = isRunLive,
  writeRunStateFn = writeRunState,
  clearRunStateFn = clearRunState,
  claimReviewSlotFn = claimReviewSlot,
  releaseReviewSlotFn = releaseOwnedReviewSlot,
  extractCodexResultFn = extractCodexResult,
  publishCodexVerdictFn = publishCodexVerdict,
  createRunner = (opts) => new CodexCliRunner(opts),
  writeFileFn = fs.writeFile,
  mkdirFn = fs.mkdir,
  now = () => Date.now()
}) {
  const runsDir = path.join(worktreeDir, "tasks", ".runs");
  const reviewedSha = gitHeadFn(worktreeDir);
  const runLog = await createRunLogFn({ runsDir, taskId });
  const jobId = runLog.runId;
  const reviewKey = reviewRunStateKey(taskId);

  // Precondition 1 (edge case: "the subject card being mid-run"): reviewing a card whose own
  // implementer/reviewer run is still writing to the worktree would read a moving tree. Checked
  // via the SAME liveness primitive orphanReaper.js already uses for every other agent --
  // reusing existing machinery, not inventing a new one.
  const subjectState = await readRunStateFn({ runsDir, taskId });
  if (await isRunLiveFn({ state: subjectState })) {
    await runLog.close();
    const publishResult = await publishPreflightBlock({
      tasksDir: path.join(worktreeDir, "tasks"),
      taskId,
      jobId,
      sprintId,
      acceptanceCriteriaVersion,
      reviewedSha,
      reason: "subject-mid-run",
      detail: { subjectRunState: subjectState },
      publishCodexVerdictFn,
      gitHeadFn,
      worktreeDir
    });
    return { jobId, refused: "subject-mid-run", publishResult };
  }

  // Precondition 2 (acceptance: "the duplicate-start claim is taken atomically BEFORE
  // runner.start() is called"): a second invocation while a review of the same card is already in
  // flight must be refused atomically, never merely overwrite the in-flight review's own
  // bookkeeping. FIX ROUND 2 (Dennie, human comment (b)) replaces the read-then-write runstate
  // check that used to live here with `claimReviewSlotFn` -- launchReservation.js's own atomic
  // `link()`-based exclusivity (see its own docstring above) -- keyed by the review job's OWN
  // reservation cardId (`reviewKey`), never the subject's bare taskId.
  const reviewOwner = { pid: process.pid, jobId };
  const claim = await claimReviewSlotFn({ runsDir, cardId: reviewKey, owner: reviewOwner });
  if (!claim.claimed) {
    await runLog.close();
    const publishResult = await publishPreflightBlock({
      tasksDir: path.join(worktreeDir, "tasks"),
      taskId,
      jobId,
      sprintId,
      acceptanceCriteriaVersion,
      reviewedSha,
      reason: claim.reason,
      detail: { existingLease: claim.existing ?? null },
      publishCodexVerdictFn,
      gitHeadFn,
      worktreeDir
    });
    return { jobId, refused: claim.reason, publishResult };
  }

  const prompt = buildReviewPrompt({ taskId, reviewedSha, acceptanceCriteriaVersion, sprintId, jobId });

  const runner = createRunner({ command: codexBin, hostEnv: { ...process.env, CODEX_HOME: codexHome } });
  const startedAt = now();
  let run;
  try {
    run = await runner.start({
      task: { id: taskId },
      prompt,
      worktreeDir,
      boardRunId: runLog.runId,
      timeoutMs,
      maxTotalTokens
    });
  } catch (err) {
    // Edge case: "runner.start() throwing after the claim is taken -- the claim must be released
    // on that path." A thrown start() never produced a child to track, so there is nothing else
    // to clean up -- just free the slot for the next attempt before propagating the failure.
    await releaseReviewSlotFn({
      runsDir,
      cardId: reviewKey,
      executionId: claim.executionId,
      invocationId: claim.invocationId,
      owner: reviewOwner,
      outcome: { status: "failed", reason: "start-threw" }
    }).catch(() => {});
    await runLog.close();
    throw err;
  }

  // Same liveness bookkeeping runOrchestrator.js's _runPhase writes for every other agent, right
  // after runner.start() returns -- but under `reviewKey`, never the subject's own `taskId` (see
  // this file's header comment). A board process that dies mid-review leaves this review job's
  // own liveness evidence on disk, without touching -- or being confused with -- the subject
  // card's own lifecycle, which orphanReaper.js never even looks at here.
  const runPid = run.child ? run.child.pid : null;
  await writeRunStateFn({ runsDir, taskId: reviewKey, pid: runPid, runLogPath: runLog.path });

  let stdout = "";
  let stderr = "";
  let exitCode = null;
  if (run.child) {
    // Streamed durably as it arrives, not buffered until exit (FIX ROUND (c): the pre-fix
    // version only ever wrote to runLog AFTER the child exited, via a post-hoc split of the
    // fully-buffered stdout string -- a crash mid-review lost every event collected so far,
    // since nothing had reached disk yet). NdjsonEventParser is the same line-buffering parser
    // ClaudeCliRunner's own stream consumer uses, so partial lines split across chunk
    // boundaries still decode correctly.
    const parser = new NdjsonEventParser({
      onEvent: (event) => {
        runLog.append(event).catch(() => {});
      }
    });
    run.child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      parser.push(chunk);
    });
    run.child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    exitCode = await new Promise((resolve) => {
      run.child.once("exit", (code) => resolve(code));
    });
    parser.end();
  }
  const durationMs = now() - startedAt;

  await runLog.close();

  let runResult;
  if (run.spawnError) {
    runResult = { kind: "process-failure", reason: "spawn-error", detail: run.spawnError.message };
  } else if (run.budgetExceeded) {
    // FIX ROUND (d): the one branch the pre-fix version never checked at all -- a token-budget
    // kill fell through to the generic non-zero-exit branch below and lost the actual reason.
    // Still a REACTIVE bound, not a preventative one (see codexCliRunner.js's own docstring):
    // the spend that triggered the breach has already happened by the time this fires, and it
    // can only stop a SUBSEQUENT turn, never the one that pushed the total over. It is
    // nonetheless a real enforced bound, not merely configured -- see codexCliRunner.test.js.
    runResult = { kind: "process-failure", reason: "budget-exceeded", detail: { maxTotalTokens } };
  } else if (run.timedOut) {
    runResult = { kind: "process-failure", reason: "timeout", detail: { timeoutMs } };
  } else if (exitCode !== 0) {
    runResult = { kind: "process-failure", reason: "non-zero-exit", detail: { exitCode, stderr: stderr.slice(-2000) } };
  } else {
    runResult = extractCodexResultFn(stdout);
  }

  const currentHead = gitHeadFn(worktreeDir);
  const tasksDir = path.join(worktreeDir, "tasks");

  const publishResult = await publishCodexVerdictFn({
    tasksDir,
    taskId,
    deliveryId: jobId,
    dispatchedJob: { jobId, ticketId: taskId, sprintId, dispatchedSha: reviewedSha, acceptanceCriteriaVersion },
    runResult,
    currentHead
  });

  const usageMatch = stdout.match(/"turn\.completed"[^\n]*"usage":\s*(\{[^}]*\})/);
  const evidence = {
    jobId,
    taskId,
    reviewedSha,
    currentHeadAtPublish: currentHead,
    startedAt: new Date(startedAt).toISOString(),
    durationMs,
    exitCode,
    timedOut: run.timedOut,
    budgetExceeded: run.budgetExceeded,
    usageRaw: usageMatch ? usageMatch[1] : null,
    runResult,
    publishResult,
    rawStdout: stdout
  };

  const evidencePath = path.join(tasksDir, ".verdicts", `${taskId}.spike-evidence.json`);
  await mkdirFn(path.dirname(evidencePath), { recursive: true });
  await writeFileFn(evidencePath, JSON.stringify(evidence, null, 2), "utf8");

  // This run's span is over (published, or evidence-recorded-as-failed) -- clear ONLY this
  // review job's own runstate, the same way runOrchestrator.js's runCard() clears its own on the
  // way out. Never touches the subject card's own runstate, which this script never wrote.
  await clearRunStateFn({ runsDir, taskId: reviewKey });

  // Free the atomic reservation claimed above -- ownership-checked (never releases a claim this
  // process doesn't actually hold, see `releaseOwnedReviewSlot`'s own docstring), so the next
  // review of this card can claim the slot fresh.
  await releaseReviewSlotFn({
    runsDir,
    cardId: reviewKey,
    executionId: claim.executionId,
    invocationId: claim.invocationId,
    owner: reviewOwner,
    outcome: { status: "completed" }
  }).catch(() => {});

  return { jobId, durationMs, exitCode, timedOut: run.timedOut, budgetExceeded: run.budgetExceeded, publishResult, evidencePath };
}

async function main() {
  const codexBin = process.env.CODEX_BIN;
  const codexHome = process.env.CODEX_HOME;
  if (!codexBin || !codexHome) {
    throw new Error("runCodexReview.js requires CODEX_BIN and CODEX_HOME to be set");
  }

  const result = await runCodexReviewJob({
    taskId: "T-0460",
    worktreeDir: REPO_ROOT,
    codexBin,
    codexHome,
    timeoutMs: process.env.CODEX_REVIEW_TIMEOUT_MS ? Number(process.env.CODEX_REVIEW_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
    acceptanceCriteriaVersion: "2026-10-21"
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.evidencePath) {
    process.stdout.write(`evidence written to ${result.evidencePath}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}
