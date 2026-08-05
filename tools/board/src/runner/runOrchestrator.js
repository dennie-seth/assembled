import path from "node:path";
import { NdjsonEventParser } from "./streamParser.js";
import { buildPrompt, buildPlannerPrompt, resolveRulesForPaths } from "./promptBuilder.js";
import { buildReviewerPrompt } from "./reviewerPrompt.js";
import { extractVerdictFromEvents } from "./verdict.js";
import { loadAgentDef, loadRules } from "./configLoader.js";
import { resolveAllowedTools } from "./toolAllowlist.js";
import { createRunLog } from "./runLog.js";
import * as gitOps from "./gitOps.js";
import * as githubOps from "./githubOps.js";
import { buildPrTitle, buildPrBody } from "./prBuilder.js";

const AUTO_OPEN_PR_DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** AUTO_OPEN_PR env var: default ON; set to "0"/"false"/"off"/"no" (any case) to disable auto-PR on PASS. */
function autoOpenPrFromEnv() {
  return !AUTO_OPEN_PR_DISABLE_VALUES.has((process.env.AUTO_OPEN_PR ?? "").toLowerCase());
}

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
 * card to `review`, FAIL moves it to `blocked` (a re-runnable terminal
 * state) with the verdict notes, and any runner failure (crash, missing
 * verdict) also blocks it instead of guessing. Never issues a transition
 * that reaches `done`.
 */
export class RunOrchestrator {
  constructor({
    store,
    hub,
    runner,
    git = gitOps,
    github = githubOps,
    autoOpenPr = autoOpenPrFromEnv(),
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
    buildPlannerPromptFn = buildPlannerPrompt,
    buildReviewerPromptFn = buildReviewerPrompt,
    extractVerdictFn = extractVerdictFromEvents,
    createRunLogFn = createRunLog,
    now = () => new Date(),
    onIdle = () => {}
  }) {
    this.store = store;
    this.hub = hub;
    this.runner = runner;
    this.git = git;
    this.github = github;
    this.autoOpenPr = autoOpenPr;
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
    this.buildPlannerPromptFn = buildPlannerPromptFn;
    this.buildReviewerPromptFn = buildReviewerPromptFn;
    this.extractVerdictFn = extractVerdictFn;
    this.createRunLogFn = createRunLogFn;
    this.now = now;
    this.onIdle = onIdle;
    this.activeRuns = new Map();
    // Tracks the full span of runCard() (worktree setup through cleanup), unlike
    // activeRuns above which is only set while a phase's child process is actually
    // alive -- it goes empty between phases (e.g. implementer exited, reviewer not
    // yet spawned). Anything gating "is it safe to restart the service" needs the
    // wider window: killing the process between phases would still orphan the run.
    this.activeCardIds = new Set();
  }

  isRunning(taskId) {
    return this.activeRuns.has(taskId);
  }

  /** True while any card run (from worktree setup through final cleanup) is in flight. */
  hasActiveRuns() {
    return this.activeCardIds.size > 0;
  }

  /**
   * Writes a task update and broadcasts it over the board socket in the same
   * tick -- the board must not depend solely on the tasks/*.md file watcher
   * (which is debounced by chokidar's atomic-write detection) to learn that
   * a run changed a card's status.
   */
  async _updateAndBroadcast(taskId, patch) {
    const updated = await this.store.update(taskId, patch);
    this.hub.broadcast({ type: "changed", id: taskId, task: updated });
    return updated;
  }

  async runCard(taskId) {
    const task = await this.store.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    if (task.status !== "ready" && task.status !== "review" && task.status !== "blocked") {
      throw new Error(`Cannot run ${taskId}: status is "${task.status}", expected "ready", "review", or "blocked"`);
    }
    if (this.activeRuns.has(taskId)) {
      throw new Error(`Task ${taskId} already has an active run`);
    }

    const branch = `feature/${taskId}`;
    const worktreeDir = path.join(this.worktreesDir, taskId);

    this.activeCardIds.add(taskId);
    try {
      let reused = false;
      try {
        const result = await this.git.addWorktree({ repoRoot: this.repoRoot, worktreeDir, branch, baseBranch: this.baseBranch });
        reused = Boolean(result && result.reused);
      } catch (err) {
        await this._blocked(taskId, `worktree creation failed: ${err.message}`);
        return;
      }

      await this._updateAndBroadcast(taskId, { status: "in-progress" });

      const runLog = await this.createRunLogFn({ runsDir: this.runsDir, taskId, now: this.now });
      try {
        await this._runCardInWorktree(taskId, task, worktreeDir, branch, runLog, reused);
      } finally {
        await runLog.close();
      }
    } finally {
      this.activeCardIds.delete(taskId);
      if (this.activeCardIds.size === 0) {
        this.onIdle();
      }
    }
  }

  async _runCardInWorktree(taskId, task, worktreeDir, branch, runLog, reused = false) {
    // Unassigned cards run planner first to expand the spec, then a generic implementer.
    if (task.agent === null) {
      const plannerOk = await this._planUnassignedCard(taskId, task, worktreeDir, runLog);
      if (!plannerOk) return;
    }

    const effectiveAgent = task.agent ?? "generic";
    const agentDef = this.loadAgentDefFn(effectiveAgent, { agentsDir: this.agentsDir });
    const rules = this.loadRulesFn({ rulesDir: this.rulesDir });
    const allowedTools = this.resolveAllowedToolsFn(effectiveAgent, { agentsDir: this.agentsDir });
    const prompt = this.buildPromptFn({
      task: { ...task, agent: effectiveAgent },
      agentDef,
      rules,
      continuing: reused,
      comments: task.comments ?? []
    });

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

    await this._updateAndBroadcast(taskId, { status: "validation" });

    const changedPaths = await this.git.diffNames({ worktreeDir, baseBranch: this.baseBranch }).catch(() => []);
    const reviewerAgentDef = this.loadAgentDefFn("reviewer", { agentsDir: this.agentsDir });
    const reviewerRules = resolveRulesForPaths(changedPaths, this.loadRulesFn({ rulesDir: this.rulesDir }));
    const reviewerAllowedTools = this.resolveAllowedToolsFn("reviewer", { agentsDir: this.agentsDir });
    const reviewerPrompt = this.buildReviewerPromptFn({
      task,
      agentDef: reviewerAgentDef,
      rules: reviewerRules,
      changedPaths,
      baseBranch: this.baseBranch
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
      await this._handlePass(taskId, task, worktreeDir, branch, verdict, runLog, reused);
    } else {
      await this._handleFailValidation(taskId, verdict);
    }
  }

  /** Runs the planner phase for an unassigned card. Returns true if planning succeeded, false if cancelled/failed (already blocked). */
  async _planUnassignedCard(taskId, task, worktreeDir, runLog) {
    this.hub.broadcast({
      type: "run-status",
      id: taskId,
      phase: "planning",
      message: "Card is unassigned — invoking planner to expand spec before implementation"
    });

    const plannerDef = this.loadAgentDefFn("planner", { agentsDir: this.agentsDir });
    const rules = this.loadRulesFn({ rulesDir: this.rulesDir });
    const plannerAllowedTools = this.resolveAllowedToolsFn("planner", { agentsDir: this.agentsDir });
    const plannerPrompt = this.buildPlannerPromptFn({ task, agentDef: plannerDef, rules });

    const plannerResult = await this._runPhase({
      taskId,
      task,
      phase: "planning",
      prompt: plannerPrompt,
      allowedTools: plannerAllowedTools,
      worktreeDir,
      model: plannerDef.model,
      runLog
    });

    if (plannerResult.cancelled) return false;
    if (plannerResult.exitCode !== 0) {
      await this._blocked(taskId, this._crashReason("planner", plannerResult));
      return false;
    }
    return true;
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
    await this._updateAndBroadcast(taskId, {
      status: "blocked",
      body: appendNote(current.body, "Cancelled", "Run cancelled by user; worktree removed, branch left intact for investigation.")
    });
  }

  async _blocked(taskId, reason) {
    const current = await this.store.get(taskId);
    await this._updateAndBroadcast(taskId, { status: "blocked", body: appendNote(current.body, "Blocked", reason) });
  }

  async _handleFailValidation(taskId, verdict) {
    const current = await this.store.get(taskId);
    await this._updateAndBroadcast(taskId, {
      status: "blocked",
      body: appendNote(current.body, "Validation: FAIL", verdict.notes)
    });
  }

  async _handlePass(taskId, task, worktreeDir, branch, verdict, runLog, reused = false) {
    let commit;
    try {
      await this.git.commitAll({
        worktreeDir,
        message: `feat: ${taskId} ${task.title}\n\nCo-authored-by: Claude <noreply@anthropic.com>`
      });
      // A continued run (reused branch) may not fast-forward from what's already on origin
      // (e.g. the implementer amended a commit while fixing an issue) -- force-with-lease it.
      const pushOptions = reused ? { worktreeDir, branch, force: true } : { worktreeDir, branch };
      await this.git.push(pushOptions);
      commit = await this.git.getHeadCommit({ worktreeDir });
    } catch (err) {
      await this._blocked(taskId, `push to review failed: ${err.message}`);
      return;
    }

    const prUrl = await this._openPullRequest({ taskId, task, worktreeDir, branch, verdict, runLog });

    try {
      await this.git.removeWorktree({ repoRoot: this.repoRoot, worktreeDir });
    } catch {
      // best-effort cleanup -- the branch is already pushed, review can proceed regardless
    }

    const current = await this.store.get(taskId);
    let body = appendNote(current.body, "Validation: PASS", verdict.notes);
    const patch = { status: "review", branch, commit, body };
    if (prUrl) {
      patch.pr = prUrl;
      patch.body = appendNote(body, "PR", prUrl);
    }
    await this._updateAndBroadcast(taskId, patch);
  }

  /**
   * Finalize step: opens (or reuses) a GitHub PR for the just-pushed branch
   * via the `gh` CLI. Degrades gracefully -- gh missing/unauthenticated, a
   * disabled autoOpenPr flag, or a `gh pr create` failure all just skip PR
   * creation and log why; none of them fail the run or block the card.
   * Returns the PR URL on success, or null when no PR was opened.
   */
  async _openPullRequest({ taskId, task, worktreeDir, branch, verdict, runLog }) {
    if (!this.autoOpenPr) {
      await this._logFinalize(taskId, runLog, "PR not opened: auto-open-pr disabled (AUTO_OPEN_PR)");
      return null;
    }

    const availability = await this.github.checkAvailability({ worktreeDir });
    if (!availability.available) {
      const message =
        availability.reason === "not-installed"
          ? "PR not opened: gh CLI not installed -- install gh and run 'gh auth login' to enable auto-PR"
          : "PR not opened: gh not authenticated -- run 'gh auth login' to enable auto-PR";
      await this._logFinalize(taskId, runLog, message);
      return null;
    }

    try {
      const existing = await this.github.findExistingPr({ worktreeDir, branch });
      if (existing) {
        await this._logFinalize(taskId, runLog, `PR already exists, reusing: ${existing}`);
        return existing;
      }

      const title = buildPrTitle({ task });
      const body = buildPrBody({ task, verdict });
      const url = await this.github.createPr({ worktreeDir, base: this.baseBranch, head: branch, title, body });
      await this._logFinalize(taskId, runLog, `Opened PR: ${url}`);
      return url;
    } catch (err) {
      await this._logFinalize(taskId, runLog, `PR not opened: gh pr create failed: ${err.message}`);
      return null;
    }
  }

  async _logFinalize(taskId, runLog, message) {
    const event = { type: "finalize", message };
    await runLog.append(event);
    this.hub.broadcast({ type: "run-event", id: taskId, phase: "finalize", event });
  }
}
