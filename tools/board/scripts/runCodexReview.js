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
import { writeRunState, readRunState, clearRunState, isRunLive } from "../src/runner/runState.js";

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

  // Precondition 2 (acceptance: "duplicate-start case ... refused rather than overwriting a
  // runstate"): a second invocation while a review of the same card is already in flight must
  // not stomp the in-flight review's own runstate with a new pid.
  const reviewState = await readRunStateFn({ runsDir, taskId: reviewKey });
  if (await isRunLiveFn({ state: reviewState })) {
    await runLog.close();
    const publishResult = await publishPreflightBlock({
      tasksDir: path.join(worktreeDir, "tasks"),
      taskId,
      jobId,
      sprintId,
      acceptanceCriteriaVersion,
      reviewedSha,
      reason: "review-already-in-flight",
      detail: { reviewRunState: reviewState },
      publishCodexVerdictFn,
      gitHeadFn,
      worktreeDir
    });
    return { jobId, refused: "review-already-in-flight", publishResult };
  }

  const prompt = buildReviewPrompt({ taskId, reviewedSha, acceptanceCriteriaVersion, sprintId, jobId });

  const runner = createRunner({ command: codexBin, hostEnv: { ...process.env, CODEX_HOME: codexHome } });
  const startedAt = now();
  const run = await runner.start({
    task: { id: taskId },
    prompt,
    worktreeDir,
    boardRunId: runLog.runId,
    timeoutMs,
    maxTotalTokens
  });

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
