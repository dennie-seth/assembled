import path from "node:path";
import { NdjsonEventParser } from "./streamParser.js";
import { buildPrompt, resolveRulesForPaths } from "./promptBuilder.js";
import { buildReviewerPrompt } from "./reviewerPrompt.js";
import { extractVerdictFromEvents } from "./verdict.js";
import { loadAgentDef, loadRules } from "./configLoader.js";
import { resolveAllowedTools } from "./toolAllowlist.js";
import { createRunLog } from "./runLog.js";
import * as gitOps from "./gitOps.js";

/** Appends a timestamped `## <heading>` note to a task body -- how validation results are recorded on the card. */
export function appendNote(body, heading, text) {
  const timestamp = new Date().toISOString();
  const trimmed = body.replace(/\n+$/, "");
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
  return `${prefix}## ${heading} (${timestamp})\n\n${text}\n`;
}

/**
 * Ties the slice-B runner engine to the board: on runCard, cuts a worktree
 * for the card, runs the implementer, hands off to the read-only reviewer,
 * and applies the reviewer's verdict -- PASS pushes the branch and moves the
 * card to `review`, FAIL sends it back to `in-progress` with reasons, and
 * any runner failure (crash, missing verdict) blocks it instead of guessing.
 * Never issues a transition that reaches `done`.
 */
export class RunOrchestrator {
  constructor({
    store,
    hub,
    runner,
    git = gitOps,
    repoRoot,
    worktreesDir = path.join(repoRoot, "worktrees"),
    runsDir = path.join(repoRoot, "tasks", ".runs"),
    agentsDir = path.join(repoRoot, ".claude", "agents"),
    rulesDir = path.join(repoRoot, ".claude", "rules"),
    baseBranch = "develop",
    loadAgentDefFn = loadAgentDef,
    loadRulesFn = loadRules,
    resolveAllowedToolsFn = resolveAllowedTools,
    buildPromptFn = buildPrompt,
    buildReviewerPromptFn = buildReviewerPrompt,
    extractVerdictFn = extractVerdictFromEvents,
    createRunLogFn = createRunLog,
    now = () => new Date()
  }) {
    this.store = store;
    this.hub = hub;
    this.runner = runner;
    this.git = git;
    this.repoRoot = repoRoot;
    this.worktreesDir = worktreesDir;
    this.runsDir = runsDir;
    this.agentsDir = agentsDir;
    this.rulesDir = rulesDir;
    this.baseBranch = baseBranch;
    this.loadAgentDefFn = loadAgentDefFn;
    this.loadRulesFn = loadRulesFn;
    this.resolveAllowedToolsFn = resolveAllowedToolsFn;
    this.buildPromptFn = buildPromptFn;
    this.buildReviewerPromptFn = buildReviewerPromptFn;
    this.extractVerdictFn = extractVerdictFn;
    this.createRunLogFn = createRunLogFn;
    this.now = now;
    this.activeRuns = new Map();
  }

  isRunning(taskId) {
    return this.activeRuns.has(taskId);
  }

  async runCard(taskId) {
    const task = await this.store.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    if (task.status !== "ready") {
      throw new Error(`Cannot run ${taskId}: status is "${task.status}", expected "ready"`);
    }
    if (this.activeRuns.has(taskId)) {
      throw new Error(`Task ${taskId} already has an active run`);
    }

    const branch = `feature/${taskId}`;
    const worktreeDir = path.join(this.worktreesDir, taskId);

    try {
      await this.git.addWorktree({ repoRoot: this.repoRoot, worktreeDir, branch, baseBranch: this.baseBranch });
    } catch (err) {
      await this._blocked(taskId, `worktree creation failed: ${err.message}`);
      return;
    }

    await this.store.update(taskId, { status: "in-progress" });

    const runLog = await this.createRunLogFn({ runsDir: this.runsDir, taskId, now: this.now });
    try {
      await this._runCardInWorktree(taskId, task, worktreeDir, branch, runLog);
    } finally {
      await runLog.close();
    }
  }

  async _runCardInWorktree(taskId, task, worktreeDir, branch, runLog) {
    const agentDef = this.loadAgentDefFn(task.agent, { agentsDir: this.agentsDir });
    const rules = this.loadRulesFn({ rulesDir: this.rulesDir });
    const allowedTools = this.resolveAllowedToolsFn(task.agent, { agentsDir: this.agentsDir });
    const prompt = this.buildPromptFn({ task, agentDef, rules });

    const implementerResult = await this._runPhase({
      taskId,
      task,
      phase: "implementer",
      prompt,
      allowedTools,
      worktreeDir,
      model: agentDef.model,
      runLog
    });
    if (implementerResult.cancelled) {
      return;
    }
    if (implementerResult.exitCode !== 0) {
      await this._blocked(taskId, this._crashReason("implementer", implementerResult));
      return;
    }

    await this.store.update(taskId, { status: "validation" });

    const changedPaths = await this.git.diffNames({ worktreeDir, baseBranch: this.baseBranch }).catch(() => []);
    const reviewerAgentDef = this.loadAgentDefFn("reviewer", { agentsDir: this.agentsDir });
    const reviewerRules = resolveRulesForPaths(changedPaths, this.loadRulesFn({ rulesDir: this.rulesDir }));
    const reviewerAllowedTools = this.resolveAllowedToolsFn("reviewer", { agentsDir: this.agentsDir });
    const reviewerPrompt = this.buildReviewerPromptFn({
      task,
      agentDef: reviewerAgentDef,
      rules: reviewerRules,
      changedPaths
    });

    const reviewerResult = await this._runPhase({
      taskId,
      task,
      phase: "reviewer",
      prompt: reviewerPrompt,
      allowedTools: reviewerAllowedTools,
      worktreeDir,
      model: reviewerAgentDef.model,
      runLog
    });
    if (reviewerResult.cancelled) {
      return;
    }
    if (reviewerResult.exitCode !== 0) {
      await this._blocked(taskId, this._crashReason("reviewer", reviewerResult));
      return;
    }

    const verdict = this.extractVerdictFn(reviewerResult.events);
    if (!verdict) {
      await this._blocked(taskId, "reviewer did not produce a machine-readable verdict");
      return;
    }

    if (verdict.verdict === "PASS") {
      await this._handlePass(taskId, task, worktreeDir, branch, verdict);
    } else {
      await this._handleFailValidation(taskId, verdict);
    }
  }

  _crashReason(phase, result) {
    if (result.spawnError) {
      return `${phase} failed to start: ${result.spawnError.message}`;
    }
    const signalSuffix = result.signal ? ` (signal ${result.signal})` : "";
    return `${phase} process exited with code ${result.exitCode ?? "null"}${signalSuffix}`;
  }

  async _runPhase({ taskId, task, phase, prompt, allowedTools, worktreeDir, model, runLog }) {
    const run = await this.runner.start({ task, prompt, allowedTools, worktreeDir, model });
    const entry = { phase, run, worktreeDir, cancelled: false };
    this.activeRuns.set(taskId, entry);

    const events = [];
    let appendChain = Promise.resolve();
    const parser = new NdjsonEventParser({
      onEvent: (event) => {
        events.push(event);
        appendChain = appendChain.then(() => runLog.append(event));
        this.hub.broadcast({ type: "run-event", id: taskId, phase, event });
      }
    });

    const child = run.child;
    if (child.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", (chunk) => parser.push(chunk));
    }

    const [exitCode, signal, spawnError] = await new Promise((resolve) => {
      child.once("exit", (code, sig) => resolve([code, sig, null]));
      child.once("error", (err) => resolve([null, null, err]));
    });
    parser.end();
    await appendChain;

    this.activeRuns.delete(taskId);
    return { exitCode, signal, spawnError, events, cancelled: entry.cancelled };
  }

  async cancelRun(taskId) {
    const entry = this.activeRuns.get(taskId);
    if (!entry) {
      throw new Error(`No active run for ${taskId}`);
    }
    entry.cancelled = true;
    const child = entry.run.child;

    const exited = new Promise((resolve) => {
      if (child.exitCode !== null && child.exitCode !== undefined) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
    });

    this.runner.kill(entry.run);
    await exited;

    try {
      await this.git.removeWorktree({ repoRoot: this.repoRoot, worktreeDir: entry.worktreeDir });
    } catch {
      // best-effort cleanup -- the card is already headed to blocked either way
    }

    const current = await this.store.get(taskId);
    await this.store.update(taskId, {
      status: "blocked",
      body: appendNote(current.body, "Cancelled", "Run cancelled by user; worktree removed, branch left intact for investigation.")
    });
  }

  async _blocked(taskId, reason) {
    const current = await this.store.get(taskId);
    await this.store.update(taskId, { status: "blocked", body: appendNote(current.body, "Blocked", reason) });
  }

  async _handleFailValidation(taskId, verdict) {
    const current = await this.store.get(taskId);
    await this.store.update(taskId, {
      status: "in-progress",
      body: appendNote(current.body, "Validation: FAIL", verdict.notes)
    });
  }

  async _handlePass(taskId, task, worktreeDir, branch, verdict) {
    let commit;
    try {
      await this.git.commitAll({
        worktreeDir,
        message: `feat: ${taskId} ${task.title}\n\nCo-authored-by: Claude <noreply@anthropic.com>`
      });
      await this.git.push({ worktreeDir, branch });
      commit = await this.git.getHeadCommit({ worktreeDir });
    } catch (err) {
      await this._blocked(taskId, `push to review failed: ${err.message}`);
      return;
    }

    try {
      await this.git.removeWorktree({ repoRoot: this.repoRoot, worktreeDir });
    } catch {
      // best-effort cleanup -- the branch is already pushed, review can proceed regardless
    }

    const current = await this.store.get(taskId);
    await this.store.update(taskId, {
      status: "review",
      branch,
      commit,
      body: appendNote(current.body, "Validation: PASS", verdict.notes)
    });
  }
}
