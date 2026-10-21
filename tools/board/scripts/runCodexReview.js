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
import { CodexCliRunner, DEFAULT_TIMEOUT_MS } from "../src/runner/codexCliRunner.js";
import { extractCodexResult } from "../src/runner/codexResultExtractor.js";
import { publishCodexVerdict } from "../src/runner/codexVerdictPublisher.js";
import { createRunLog } from "../src/runner/runLog.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function gitHead(cwd) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();
}

function buildReviewPrompt({ taskId, reviewedSha, acceptanceCriteriaVersion, sprintId, jobId }) {
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

async function main() {
  const codexBin = process.env.CODEX_BIN;
  const codexHome = process.env.CODEX_HOME;
  if (!codexBin || !codexHome) {
    throw new Error("runCodexReview.js requires CODEX_BIN and CODEX_HOME to be set");
  }

  const taskId = "T-0460";
  const worktreeDir = REPO_ROOT;
  const reviewedSha = gitHead(worktreeDir);
  const acceptanceCriteriaVersion = "2026-10-21";
  const sprintId = "spike"; // placeholder: no sprint scheduler exists yet, out of scope per this card's own Scope section
  const timeoutMs = process.env.CODEX_REVIEW_TIMEOUT_MS ? Number(process.env.CODEX_REVIEW_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;

  const runsDir = path.join(worktreeDir, "tasks", ".runs");
  const runLog = await createRunLog({ runsDir, taskId });
  const jobId = runLog.runId;

  const prompt = buildReviewPrompt({ taskId, reviewedSha, acceptanceCriteriaVersion, sprintId, jobId });

  const runner = new CodexCliRunner({ command: codexBin, hostEnv: { ...process.env, CODEX_HOME: codexHome } });
  const startedAt = Date.now();
  const run = await runner.start({
    task: { id: taskId },
    prompt,
    worktreeDir,
    boardRunId: runLog.runId,
    timeoutMs
  });

  let stdout = "";
  let stderr = "";
  let exitCode = null;
  if (run.child) {
    run.child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    run.child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    exitCode = await new Promise((resolve) => {
      run.child.once("exit", (code) => resolve(code));
    });
  }
  const durationMs = Date.now() - startedAt;

  for (const line of stdout.split("\n").filter(Boolean)) {
    try {
      await runLog.append(JSON.parse(line));
    } catch {
      await runLog.append({ type: "raw-line", line });
    }
  }
  await runLog.close();

  let runResult;
  if (run.spawnError) {
    runResult = { kind: "process-failure", reason: "spawn-error", detail: run.spawnError.message };
  } else if (run.timedOut) {
    runResult = { kind: "process-failure", reason: "timeout", detail: { timeoutMs } };
  } else if (exitCode !== 0) {
    runResult = { kind: "process-failure", reason: "non-zero-exit", detail: { exitCode, stderr: stderr.slice(-2000) } };
  } else {
    runResult = extractCodexResult(stdout);
  }

  const currentHead = gitHead(worktreeDir);

  const publishResult = await publishCodexVerdict({
    tasksDir: path.join(worktreeDir, "tasks"),
    taskId,
    deliveryId: jobId,
    dispatchedJob: { jobId, ticketId: taskId, sprintId, dispatchedSha: reviewedSha },
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
    usageRaw: usageMatch ? usageMatch[1] : null,
    runResult,
    publishResult,
    rawStdout: stdout
  };

  const evidencePath = path.join(worktreeDir, "tasks", ".verdicts", `${taskId}.spike-evidence.json`);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8");

  process.stdout.write(`${JSON.stringify({ jobId, durationMs, exitCode, timedOut: run.timedOut, publishResult }, null, 2)}\n`);
  process.stdout.write(`evidence written to ${evidencePath}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
