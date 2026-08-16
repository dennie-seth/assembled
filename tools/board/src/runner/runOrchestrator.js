import path from "node:path";
import { NdjsonEventParser } from "./streamParser.js";
import { buildPrompt, buildPlannerPrompt, buildMergeConflictPrompt, resolveRulesForPaths } from "./promptBuilder.js";
import { buildReviewerPrompt } from "./reviewerPrompt.js";
import { extractVerdictFromEvents } from "./verdict.js";
import { crossCheckVerdict } from "./verdictCrossCheck.js";
import { loadAgentDef, loadRules } from "./configLoader.js";
import { resolveAllowedTools } from "./toolAllowlist.js";
import { createRunLog } from "./runLog.js";
import { writeRunState, clearRunState } from "./runState.js";
import * as gitOps from "./gitOps.js";
import * as githubOps from "./githubOps.js";
import { buildPrTitle, buildPrBody } from "./prBuilder.js";
import {
  materializePlannerFileView,
  cleanupPlannerFileView,
  diffPlannerFileView,
  applyPlannerFileViewDiff
} from "./plannerFileView.js";
import { eventsContainUsageLimitSignature } from "./usageLimitDetector.js";
import { buildBlockerReport, formatBlockerReportComment } from "./blockerReport.js";
import { findExistingRemediationCard, draftRemediationCard } from "../lib/escalationRemediation.js";
import { createCard as createCardDefault } from "./cardCreation.js";

/**
 * Hard cap on total implementer/reviewer runs a card can consume across its bounded
 * FAIL -> auto-retry -> FAIL -> ... loop before it's left `blocked` for a human. Persisted
 * per-card as the `attempts` frontmatter field (see taskParser.js); reset to 0 at the start
 * of every human/API-initiated runCard() call (see runCard's fresh-allowance reset) and on
 * PASS (see _handlePass), so a card that exhausts its 5 auto-retries and gets manually
 * re-run always gets a full new allowance rather than staying permanently capped.
 */
export const MAX_AUTO_RETRY_ATTEMPTS = 5;

/**
 * Wall-clock cap on a single run phase (implementer, reviewer, planner, or merge-conflict
 * resolution -- anything routed through `_runPhase`). Root-cause fix for T-0185: two
 * `godot --headless test_signal_tower.gd` subprocesses that never called `get_tree().quit()`
 * kept their parent `claude` child alive forever, so the plain `await child.once("exit")` this
 * used to be never resolved -- invisible to the orphan reaper too, since the card stayed in
 * `activeCardIds` the whole time (see orphanReaper.js's own wedged-run cross-check for the
 * complementary fix on that side). 40 minutes is deliberately generous: the longest legitimate
 * phases observed are `server-db-verify`'s from-scratch `cmake --build` and a Python package's
 * `pip install -e ".[dev]"` + `pytest` (verifyRouter.js), both well under 15 minutes; this
 * leaves a wide margin before ever cutting off real work.
 */
export const DEFAULT_PHASE_TIMEOUT_MS = 40 * 60 * 1000;

const PHASE_TIMEOUT_ENV_VAR = "PHASE_TIMEOUT_MS";

/** PHASE_TIMEOUT_MS env var: overrides DEFAULT_PHASE_TIMEOUT_MS when set to a positive number. */
function phaseTimeoutMsFromEnv() {
  const raw = process.env[PHASE_TIMEOUT_ENV_VAR];
  const parsed = Number(raw);
  return raw && Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PHASE_TIMEOUT_MS;
}

const AUTO_OPEN_PR_DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** AUTO_OPEN_PR env var: default ON; set to "0"/"false"/"off"/"no" (any case) to disable auto-PR on PASS. */
function autoOpenPrFromEnv() {
  return !AUTO_OPEN_PR_DISABLE_VALUES.has((process.env.AUTO_OPEN_PR ?? "").toLowerCase());
}

const AUTO_CAPTURE_UNCOMMITTED_DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/**
 * AUTO_CAPTURE_UNCOMMITTED_WORK env var: default ON; set to "0"/"false"/"off"/"no" (any case) to
 * disable the post-implementer capture safety net (see `_captureUncommittedImplementerWork`).
 */
function autoCaptureUncommittedFromEnv() {
  return !AUTO_CAPTURE_UNCOMMITTED_DISABLE_VALUES.has((process.env.AUTO_CAPTURE_UNCOMMITTED_WORK ?? "").toLowerCase());
}

/** Appends a timestamped `## <heading>` note to a task body -- how validation results are recorded on the card. */
export function appendNote(body, heading, text) {
  const timestamp = new Date().toISOString();
  const trimmed = body.replace(/\n+$/, "");
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
  return `${prefix}## ${heading} (${timestamp})\n\n${text}\n`;
}

/**
 * Ties the slice-B runner engine to the board: on runCard, cuts a worktree for the card,
 * runs the implementer, hands off to the read-only reviewer, and applies the reviewer's
 * verdict -- PASS pushes the branch and moves the card to `review`; FAIL automatically
 * re-runs the implementer on the same worktree/branch (with the FAIL notes + comments
 * injected into its prompt, the same resume mechanics a manual re-run uses) for up to
 * MAX_AUTO_RETRY_ATTEMPTS total runs, and only lands the card on `blocked` once that cap
 * is consumed. Any runner failure (crash, missing verdict) blocks it immediately instead of
 * guessing or retrying. Never issues a transition that reaches `done`.
 */
export class RunOrchestrator {
  constructor({
    store,
    hub,
    runner,
    git = gitOps,
    github = githubOps,
    autoOpenPr = autoOpenPrFromEnv(),
    autoCaptureUncommitted = autoCaptureUncommittedFromEnv(),
    phaseTimeoutMs = phaseTimeoutMsFromEnv(),
    repoRoot,
    worktreesDir = path.join(repoRoot, "worktrees"),
    runsDir = path.join(repoRoot, "tasks", ".runs"),
    tasksDir = path.join(repoRoot, "tasks"),
    agentsDir = path.join(repoRoot, ".claude", "agents"),
    rulesDir = path.join(repoRoot, ".claude", "rules"),
    baseBranch = "develop",
    taskStoreKind = "fs",
    idAllocator,
    loadAgentDefFn = loadAgentDef,
    loadRulesFn = loadRules,
    resolveAllowedToolsFn = resolveAllowedTools,
    buildPromptFn = buildPrompt,
    buildPlannerPromptFn = buildPlannerPrompt,
    buildReviewerPromptFn = buildReviewerPrompt,
    buildMergeConflictPromptFn = buildMergeConflictPrompt,
    extractVerdictFn = extractVerdictFromEvents,
    crossCheckVerdictFn = crossCheckVerdict,
    createRunLogFn = createRunLog,
    writeRunStateFn = writeRunState,
    clearRunStateFn = clearRunState,
    createCardFn = createCardDefault,
    now = () => new Date(),
    onIdle = () => {}
  }) {
    this.store = store;
    this.hub = hub;
    this.runner = runner;
    this.git = git;
    this.github = github;
    this.autoOpenPr = autoOpenPr;
    this.autoCaptureUncommitted = autoCaptureUncommitted;
    this.phaseTimeoutMs = phaseTimeoutMs;
    this.repoRoot = repoRoot;
    this.worktreesDir = worktreesDir;
    this.runsDir = runsDir;
    this.tasksDir = tasksDir;
    this.agentsDir = agentsDir;
    this.rulesDir = rulesDir;
    this.baseBranch = baseBranch;
    this.taskStoreKind = taskStoreKind;
    this.idAllocator = idAllocator;
    this.loadAgentDefFn = loadAgentDefFn;
    this.loadRulesFn = loadRulesFn;
    this.resolveAllowedToolsFn = resolveAllowedToolsFn;
    this.buildPromptFn = buildPromptFn;
    this.buildPlannerPromptFn = buildPlannerPromptFn;
    this.buildReviewerPromptFn = buildReviewerPromptFn;
    this.buildMergeConflictPromptFn = buildMergeConflictPromptFn;
    this.extractVerdictFn = extractVerdictFn;
    this.crossCheckVerdictFn = crossCheckVerdictFn;
    this.createRunLogFn = createRunLogFn;
    this.writeRunStateFn = writeRunStateFn;
    this.clearRunStateFn = clearRunStateFn;
    this.createCardFn = createCardFn;
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
   *
   * Also commits the card file to repoRoot, the same way handlePatchTask/comments/
   * attachments do (see httpApi.js) -- every in-run status flip (ready -> in-progress ->
   * validation -> review, or -> blocked) used to leave repoRoot's working tree dirty, which
   * is exactly what made the Done-triggered `pullDevelop` abort with "local changes would be
   * overwritten by merge" the moment origin touched the same card file. Best-effort: a commit
   * failure (e.g. a lock collision with a concurrent pull) must never fail the run itself, so
   * it's caught and logged -- the card falls back to the old drift-until-next-write behavior
   * for that one write, same as handlePatchTask's matching fallback.
   *
   * In db mode (`taskStoreKind === "db"`), the commit step is skipped entirely -- there is no
   * tasks/*.md file to commit, card state lives only in SQLite (docs/design/cards-to-database.md,
   * Phase 2). The broadcast above already fires unconditionally, so the board's live view never
   * depended on the commit in the first place.
   */
  async _updateAndBroadcast(taskId, patch) {
    const updated = await this.store.update(taskId, patch);
    this.hub.broadcast({ type: "changed", id: taskId, task: updated });

    if (this.taskStoreKind !== "db" && this.repoRoot && this.tasksDir && this.git.autoCommitCardsOnCreateFromEnv()) {
      try {
        const relativePath = path.relative(this.repoRoot, path.join(this.tasksDir, `${taskId}.md`));
        const changedFields = Object.keys(patch).filter((key) => key !== "id");
        const message =
          changedFields.length > 0
            ? `chore(board): update card ${taskId} (${changedFields.join(", ")})`
            : `chore(board): update card ${taskId}`;
        await this.git.commitTaskFile({ repoRoot: this.repoRoot, filePath: relativePath, message });
      } catch (err) {
        console.warn(`Board: failed to commit run-status update for ${taskId} (leaving it untracked):`, err.message);
      }
    }

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
    // "dispatch" is the escalation flow's non-executable sentinel (see escalationRemediation.js
    // / taskParser.js's ASSIGNABLE_AGENT_NAMES comment): this is the pick-up loop's chokepoint --
    // every run, manual or automated, passes through runCard() -- so refusing it here is what
    // guarantees a remediation card surfaces in `ready` for a human/Dispatch to grab and never
    // gets auto-run.
    if (task.agent === "dispatch") {
      throw new Error(`Cannot run ${taskId}: assigned to "dispatch" -- awaiting human/Dispatch pickup, not eligible for automated runs`);
    }
    // Guards re-entrancy across the whole runCard span, including the auto-retry loop's
    // FAIL -> next-attempt gap where the phase-level activeRuns map is momentarily empty
    // (see _runPhase) but the card is still very much in flight -- activeRuns alone would
    // let a concurrent call slip through in that window.
    if (this.activeCardIds.has(taskId)) {
      throw new Error(`Task ${taskId} already has an active run`);
    }

    const branch = `feature/${taskId}`;
    const worktreeDir = path.join(this.worktreesDir, taskId);

    this.activeCardIds.add(taskId);
    try {
      // Human/API-initiated run: always grants a fresh auto-retry allowance, even if the
      // card was previously blocked for exhausting all MAX_AUTO_RETRY_ATTEMPTS auto-retries.
      await this._updateAndBroadcast(taskId, { attempts: 0 });

      let reused = false;
      try {
        const result = await this.git.addWorktree({ repoRoot: this.repoRoot, worktreeDir, branch, baseBranch: this.baseBranch });
        reused = Boolean(result && result.reused);
      } catch (err) {
        await this._blocked(taskId, `worktree creation failed: ${err.message}`);
        return;
      }

      await this.git.linkBoardNodeModules({ worktreeDir, repoRoot: this.repoRoot });

      await this._updateAndBroadcast(taskId, { status: "in-progress" });

      const runLog = await this.createRunLogFn({ runsDir: this.runsDir, taskId, now: this.now });
      try {
        await this._runCardInWorktree(taskId, task, worktreeDir, branch, runLog, reused);
      } finally {
        await runLog.close();
      }
    } finally {
      this.activeCardIds.delete(taskId);
      // Best-effort: the orphan reaper only ever trusts a *present* runstate file, so once
      // there's no more span of runCard() left to protect, clearing it (rather than leaving a
      // stale pid behind) keeps a future restart's liveness check from having to reason about
      // a runstate written by a run that's already fully finished.
      await this.clearRunStateFn({ runsDir: this.runsDir, taskId });
      if (this.activeCardIds.size === 0) {
        this.onIdle();
      }
    }
  }

  /**
   * Runs the implementer -> reviewer cycle, looping on reviewer FAIL up to
   * MAX_AUTO_RETRY_ATTEMPTS total attempts (see the class docstring). The retry itself is a
   * plain in-process loop -- not a fresh call to the public runCard() -- so it stays inside
   * this single runCard() invocation's activeCardIds span the whole time: the orphanReaper
   * (which only reaps cards absent from activeCardIds) and the restart coordinator's
   * hasActiveRuns() guard both see one continuous in-flight run across every retry, exactly
   * like a live run today, instead of a card that repeatedly looks idle between attempts.
   * Each attempt is a full sequential implementer+reviewer cycle -- never parallel, never a
   * tight loop, since each iteration blocks on real `claude` child processes.
   *
   * This is also what fixes the pre-#63 dead end: that version set the FAIL status to
   * `in-progress`, a status runCard()'s own guard rejects, so nothing could ever act on it
   * again. Driving the retry as a direct in-process call here means it never depends on a
   * status a human (or the HTTP API) would have to click "Run" on.
   */
  async _runCardInWorktree(taskId, task, worktreeDir, branch, runLog, reused = false) {
    // Unassigned cards run planner first to expand the spec, then a generic implementer.
    if (task.agent === null) {
      const plannerOk = await this._planUnassignedCard(taskId, task, worktreeDir, runLog);
      if (!plannerOk) return;
    }
    const effectiveAgent = task.agent ?? "generic";

    let currentReused = reused;
    const attemptRecords = [];
    for (let attempt = 1; attempt <= MAX_AUTO_RETRY_ATTEMPTS; attempt++) {
      // Re-fetch: a prior attempt in this same loop may have appended a FAIL note to the
      // body (read by the implementer's "continuing existing work" prompt on the retry).
      const liveTask = await this.store.get(taskId);
      await this._updateAndBroadcast(taskId, { attempts: attempt });

      const { stop, verdict, events } = await this._runAttempt(
        taskId,
        liveTask,
        effectiveAgent,
        worktreeDir,
        branch,
        runLog,
        currentReused
      );
      if (stop) return;

      if (verdict.verdict === "PASS") {
        await this._handlePass(taskId, liveTask, worktreeDir, branch, verdict, runLog, currentReused, effectiveAgent);
        return;
      }

      attemptRecords.push({ attempt, notes: verdict.notes, events });

      const isFinalAttempt = attempt >= MAX_AUTO_RETRY_ATTEMPTS;
      await this._handleFailValidation(taskId, verdict, attempt, /* retrying */ !isFinalAttempt);
      if (isFinalAttempt) {
        await this._escalateIfGenuineBlocker(taskId, attemptRecords, runLog);
        return;
      }

      // Every attempt after the first resumes the same worktree/branch, regardless of
      // whether addWorktree itself had to reuse it (a first attempt can start fresh).
      currentReused = true;
    }
  }

  /** Runs one implementer+reviewer cycle. Returns `{stop: true}` once the card has already been left in a terminal state (crash/blocked/cancelled) -- the caller must not act further -- or `{stop: false, verdict}` for the caller to grade. */
  async _runAttempt(taskId, task, effectiveAgent, worktreeDir, branch, runLog, reused) {
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
      return { stop: true };
    }
    if (implementerResult.timedOut) {
      await this._blocked(taskId, this._timeoutReason("implementer"));
      return { stop: true };
    }
    if (implementerResult.exitCode !== 0) {
      await this._blocked(taskId, this._crashReason("implementer", implementerResult));
      return { stop: true };
    }

    if (this.autoCaptureUncommitted) {
      await this._captureUncommittedImplementerWork(taskId, worktreeDir, runLog);
    }

    const changedPaths = await this.git.diffNames({ worktreeDir, baseBranch: this.baseBranch }).catch(() => []);

    if (changedPaths.length === 0) {
      const note =
        "no commits on branch — skipping validation; the implementer phase produced no committed changes relative to develop";
      await this._logCapture(taskId, runLog, note);
      await this._blocked(taskId, note);
      return { stop: true };
    }

    await this._updateAndBroadcast(taskId, { status: "validation" });
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
      return { stop: true };
    }
    if (reviewerResult.timedOut) {
      await this._blocked(taskId, this._timeoutReason("reviewer"));
      return { stop: true };
    }
    if (reviewerResult.exitCode !== 0) {
      await this._blocked(taskId, this._crashReason("reviewer", reviewerResult));
      return { stop: true };
    }

    const selfReportedVerdict = this.extractVerdictFn(reviewerResult.events);
    if (!selfReportedVerdict) {
      await this._blocked(taskId, "reviewer did not produce a machine-readable verdict");
      return { stop: true };
    }

    const verdict = this.crossCheckVerdictFn({
      verdict: selfReportedVerdict,
      events: reviewerResult.events,
      changedPaths,
      task,
      baseBranch: this.baseBranch
    });
    if (verdict.downgraded) {
      await this._logCrossCheck(taskId, runLog, verdict.notes);
    }

    return { stop: false, verdict, events: [...implementerResult.events, ...reviewerResult.events] };
  }

  /**
   * Runs the planner phase for an unassigned card. Returns true if planning succeeded, false if
   * cancelled/failed (already blocked).
   *
   * In db mode, wraps the run with the "ephemeral file view" (docs/design/cards-to-database.md,
   * "The planner problem"): materializes the DB's cards to `<worktreeDir>/tasks/*.md` before the
   * planner runs, so its unmodified Read/Edit/Write workflow has real files to act on, then
   * reconciles whatever it wrote back into the DB (enforcing the same status-unchanged/
   * no-delete guardrails `plannerDiffGuard.js` enforces via git diff in fs mode, just applied to
   * two in-memory snapshots instead) and deletes the scratch directory before returning -- the
   * implementer phase that follows must never see it. In fs mode this whole block is a no-op:
   * the planner edits the real tasks/*.md file and commits it as part of the card's own branch,
   * unchanged from before this refactor.
   */
  async _planUnassignedCard(taskId, task, worktreeDir, runLog) {
    this.hub.broadcast({
      type: "run-status",
      id: taskId,
      phase: "planning",
      message: "Card is unassigned — invoking planner to expand spec before implementation"
    });

    const fileView =
      this.taskStoreKind === "db" ? await materializePlannerFileView({ store: this.store, worktreeDir }) : null;

    const plannerDef = this.loadAgentDefFn("planner", { agentsDir: this.agentsDir });
    const rules = this.loadRulesFn({ rulesDir: this.rulesDir });
    const plannerAllowedTools = this.resolveAllowedToolsFn("planner", { agentsDir: this.agentsDir });
    const plannerPrompt = this.buildPlannerPromptFn({
      task,
      agentDef: plannerDef,
      rules,
      comments: task.comments ?? []
    });

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

    if (plannerResult.cancelled) {
      if (fileView) await cleanupPlannerFileView({ worktreeDir, hiddenPaths: fileView.hiddenPaths });
      return false;
    }
    if (plannerResult.timedOut) {
      if (fileView) await cleanupPlannerFileView({ worktreeDir, hiddenPaths: fileView.hiddenPaths });
      await this._blocked(taskId, this._timeoutReason("planner"));
      return false;
    }
    if (plannerResult.exitCode !== 0) {
      if (fileView) await cleanupPlannerFileView({ worktreeDir, hiddenPaths: fileView.hiddenPaths });
      await this._blocked(taskId, this._crashReason("planner", plannerResult));
      return false;
    }

    if (fileView) {
      const plan = await diffPlannerFileView({ tasksDir: fileView.tasksDir, before: fileView.before });
      await cleanupPlannerFileView({ worktreeDir, hiddenPaths: fileView.hiddenPaths });
      if (!plan.ok) {
        const summary = plan.violations.map((v) => `${v.file}: ${v.message}`).join("; ");
        await this._blocked(taskId, `planner guardrail violation: ${summary}`);
        return false;
      }
      const { createdIds, updatedIds } = await applyPlannerFileViewDiff({ store: this.store, plan });
      for (const id of createdIds) {
        const created = await this.store.get(id);
        this.hub.broadcast({ type: "added", id, task: created });
      }
      for (const id of updatedIds) {
        const updated = await this.store.get(id);
        this.hub.broadcast({ type: "changed", id, task: updated });
      }
    }
    return true;
  }

  /**
   * Safety net for the implementer's own workflow ("implement to green, self-verify, commit your
   * work locally, then stop"): an agent that gets absorbed in self-verification -- or hits a
   * denied/unavailable tool mid-check -- can reach `end_turn` without ever running that final
   * commit. The work is real and tested, but it sits as unstaged/untracked changes that the
   * reviewer's git-history-based checks (`git diff base...HEAD`, `git log`) can't see, so it
   * FAILs on "implementation not committed" even though the implementation is done (observed live
   * on T-0129, T-0131, T-0132 -- config.py/engine.py/types.py, invariants.py, and run_round3.py
   * respectively, all uncommitted after the implementer phase ended cleanly).
   *
   * Runs after the implementer phase and before the reviewer is ever spawned, so the reviewer's
   * diff reflects the complete work. Attributed to the board, not the agent, since the agent
   * never authored a commit for it. `commitAll` no-ops (returns false) on an already-clean
   * worktree, so this never creates an empty commit.
   */
  async _captureUncommittedImplementerWork(taskId, worktreeDir, runLog) {
    const message = [
      `chore(${taskId}): capture uncommitted implementer changes`,
      "",
      "Auto-captured by the Agent Runner orchestrator: the implementer phase ended with " +
        "changes still uncommitted in the worktree. The content originates from that phase, " +
        "not from this commit's author.",
      "",
      "Co-authored-by: Claude <noreply@anthropic.com>"
    ].join("\n");
    const captured = await this.git.commitAll({
      worktreeDir,
      message,
      author: gitOps.BOARD_COMMIT_AUTHOR
    });
    if (captured) {
      await this._logCapture(
        taskId,
        runLog,
        "Captured uncommitted implementer changes before review -- the worktree was not clean after the implementer phase finished."
      );
    }
    return captured;
  }

  async _logCapture(taskId, runLog, message) {
    const event = { type: "capture", message };
    await runLog.append(event);
    this.hub.broadcast({ type: "run-event", id: taskId, phase: "capture", event });
  }

  /**
   * Logs a harness-side verdict downgrade (crossCheckVerdictFn caught a self-reported PASS that
   * the reviewer's own required commands don't back up). The downgraded verdict's `notes` --
   * which already explain the mismatch -- flow into the card body through the normal FAIL path
   * (`_handleFailValidation`/`_blocked`) right after this call, so this is purely for run-log/
   * console visibility, not the only place the reason is surfaced.
   */
  async _logCrossCheck(taskId, runLog, message) {
    const event = { type: "crosscheck", message };
    await runLog.append(event);
    this.hub.broadcast({ type: "run-event", id: taskId, phase: "crosscheck", event });
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
    // Persisted so the orphan reaper can tell a genuinely-dead run from one whose detached
    // `claude` child (see claudeCliRunner.js) survived a board restart with the same pid --
    // overwritten on every phase since the implementer and reviewer are separate child
    // processes within one runCard() span.
    await this.writeRunStateFn({ runsDir: this.runsDir, taskId, pid: run.child.pid, runLogPath: runLog.path, now: this.now });

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
    const onStdoutData = (chunk) => parser.push(chunk);
    if (child.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", onStdoutData);
    }

    // Root-cause fix for T-0185: a hung grandchild (e.g. a headless Godot test that never calls
    // `get_tree().quit()`) previously kept this `await` pending forever, since the parent
    // `claude` child stays alive right along with it -- see DEFAULT_PHASE_TIMEOUT_MS's docstring.
    let timeoutTimer;
    const exitPromise = new Promise((resolve) => {
      child.once("exit", (code, sig) => resolve({ exitCode: code, signal: sig, spawnError: null, timedOut: false }));
      child.once("error", (err) => resolve({ exitCode: null, signal: null, spawnError: err, timedOut: false }));
    });
    const timeoutPromise = new Promise((resolve) => {
      timeoutTimer = setTimeout(
        () => resolve({ exitCode: null, signal: null, spawnError: null, timedOut: true }),
        this.phaseTimeoutMs
      );
      if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();
    });

    const result = await Promise.race([exitPromise, timeoutPromise]);
    clearTimeout(timeoutTimer);

    if (result.timedOut) {
      // Stop streaming further output into an event log for a phase that's already being
      // treated as over -- the kill below may take a moment (TERM-then-KILL escalation, see
      // ClaudeCliRunner.kill) and the child can keep writing to stdout in the meantime.
      if (child.stdout && typeof child.stdout.off === "function") {
        child.stdout.off("data", onStdoutData);
      }
      this.runner.kill(run);
    }

    parser.end();
    await appendChain;

    this.activeRuns.delete(taskId);
    return { ...result, events, cancelled: entry.cancelled };
  }

  /** Human-readable reason for a phase blocked by `DEFAULT_PHASE_TIMEOUT_MS` (or its override). */
  _timeoutReason(phase) {
    const minutes = Math.round(this.phaseTimeoutMs / 60_000);
    return `${phase} run exceeded ${minutes} minute${minutes === 1 ? "" : "s"} and was terminated -- likely a hung subprocess`;
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

  /** `(run N of MAX)` suffix on every FAIL note -- the attempt-count visibility the auto-retry loop needs on the card. */
  _failNoteText(verdict, attempt, capped) {
    const progress = `(run ${attempt} of ${MAX_AUTO_RETRY_ATTEMPTS})`;
    const capSuffix = capped ? " Auto-retry limit reached -- blocked for human review." : "";
    return `${verdict.notes}\n\n${progress}${capSuffix}`;
  }

  /**
   * Records a FAIL verdict. `retrying` (true for every attempt but the last) keeps the card
   * at `status: "in-progress"` -- the same status a live run shows -- since the auto-retry
   * loop is about to re-invoke the implementer itself; the final attempt instead moves the
   * card to `blocked` for a human, with a note explaining the cap was reached.
   */
  async _handleFailValidation(taskId, verdict, attempt, retrying) {
    const current = await this.store.get(taskId);
    await this._updateAndBroadcast(taskId, {
      status: retrying ? "in-progress" : "blocked",
      body: appendNote(current.body, "Validation: FAIL", this._failNoteText(verdict, attempt, !retrying))
    });
  }

  /**
   * Escalation step, fired once at the exhaustion boundary of the auto-retry loop (the 5th
   * consecutive FAIL that just set the card to `blocked` -- see docs/design/escalation-workflow.md).
   *
   * First checks whether the run(s) failed because of an Anthropic token/usage/weekly/rate limit
   * -- a transient environmental stop, not a genuine blocker -- by scanning every attempt's raw
   * NDJSON events for a usage-limit signature (usageLimitDetector.js). If so, this is a no-op:
   * no report, no remediation card, the card is simply left `blocked` for a normal later re-run.
   *
   * Otherwise, deterministically builds a structured blocker report from the reviewer FAIL
   * verdicts the card actually accumulated across its exhausted attempts (blockerReport.js -- no
   * extra `claude` invocation; see that module's docstring for why), appends it to the card as a
   * comment, then hands off to remediation-card creation: de-dupes against an already-open
   * remediation card for this same blocked card (escalationRemediation.js), creates a new one in
   * `ready` status owned by the non-executable `agent: "dispatch"` sentinel when none exists yet
   * (reusing cardCreation.js's `createCard`, the same direct-to-store path flow-stats
   * self-improvement uses -- not a live planner agent run, since that would require its own
   * worktree/branch/PR and could never land a `ready` card on the live board immediately), and
   * wires the original card's `depends_on` to the remediation card either way (idempotent).
   *
   * Best-effort end to end: any failure here (a missing store.list in a lightweight caller, a
   * create failure) is caught and logged, never rethrown -- the card is already correctly
   * `blocked` by the time this runs, and escalation is additive, not load-bearing for that.
   */
  async _escalateIfGenuineBlocker(taskId, attemptRecords, runLog) {
    try {
      const allEvents = attemptRecords.flatMap((r) => r.events ?? []);
      if (eventsContainUsageLimitSignature(allEvents)) {
        await this._logEscalation(
          taskId,
          runLog,
          "Escalation skipped: usage/rate-limit signature detected in the run output -- treated as a transient stop, card left blocked for a normal later re-run."
        );
        return;
      }

      const task = await this.store.get(taskId);
      const report = buildBlockerReport({ task, attemptRecords, attemptCount: attemptRecords.length });
      await this._appendComment(taskId, "assembled-board", formatBlockerReportComment(report));

      const tasks = await this.store.list();
      let remediation = findExistingRemediationCard(tasks, taskId);
      if (!remediation) {
        const fields = draftRemediationCard({ task, report, attemptCount: attemptRecords.length, now: this.now });
        remediation = await this.createCardFn({
          store: this.store,
          idAllocator: this.idAllocator,
          repoRoot: this.repoRoot,
          tasksDir: this.tasksDir,
          fields,
          taskStoreKind: this.taskStoreKind,
          hub: this.hub
        });
        await this._logEscalation(
          taskId,
          runLog,
          `Escalation: created remediation card ${remediation.id} (agent: dispatch) and linked it as a dependency.`
        );
      } else {
        await this._logEscalation(
          taskId,
          runLog,
          `Escalation: remediation card ${remediation.id} already exists for ${taskId} -- skipping creation, ensuring the dependency link.`
        );
      }

      await this._linkDependsOn(taskId, remediation.id);
    } catch (err) {
      console.warn(`Board: escalation failed for ${taskId} (card remains blocked, no report/remediation created):`, err.message);
      await this._logEscalation(taskId, runLog, `Escalation failed: ${err.message}`).catch(() => {});
    }
  }

  async _appendComment(taskId, author, text) {
    const current = await this.store.get(taskId);
    const comments = [...(current.comments ?? []), { author, text, timestamp: this.now().toISOString() }];
    return this._updateAndBroadcast(taskId, { comments });
  }

  async _linkDependsOn(taskId, dependencyId) {
    const current = await this.store.get(taskId);
    const existing = current.depends_on ?? [];
    if (existing.includes(dependencyId)) return current;
    return this._updateAndBroadcast(taskId, { depends_on: [...existing, dependencyId] });
  }

  async _logEscalation(taskId, runLog, message) {
    const event = { type: "escalation", message };
    await runLog.append(event);
    this.hub.broadcast({ type: "run-event", id: taskId, phase: "escalation", event });
  }

  async _handlePass(taskId, task, worktreeDir, branch, verdict, runLog, reused = false, effectiveAgent = task.agent ?? "generic") {
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

    // Every card/flow that ends up with an open PR must keep that branch in sync with
    // origin/develop before it's left for a human -- see _syncBranchWithDevelop's docstring.
    // Scoped to prUrl truthy (a PR actually exists, whether freshly opened or reused) since a
    // card with no PR (gh unavailable, autoOpenPr disabled) has nothing to keep in sync yet.
    const syncOutcome = prUrl
      ? await this._syncBranchWithDevelop({ taskId, task, effectiveAgent, worktreeDir, branch, runLog })
      : { ok: true };

    if (syncOutcome.skip) {
      // A cancel fired mid conflict-resolution phase -- cancelRun() already finalized the
      // card's status and removed the worktree; nothing further to do here.
      return;
    }

    try {
      await this.git.removeWorktree({ repoRoot: this.repoRoot, worktreeDir });
    } catch {
      // best-effort cleanup -- the branch is already pushed, review can proceed regardless
    }

    const current = await this.store.get(taskId);
    let body = appendNote(current.body, "Validation: PASS", verdict.notes);
    // PASS clears the auto-retry counter -- the card is starting a clean slate for review,
    // not carrying over how many attempts a previous round of FAILs consumed.
    const patch = { status: "review", branch, commit, body, attempts: 0 };
    if (prUrl) {
      patch.pr = prUrl;
      patch.body = appendNote(body, "PR", prUrl);
    }

    if (!syncOutcome.ok) {
      // The PR exists but the branch could not be brought in sync with develop -- surface it
      // explicitly rather than silently settling the card into review with a stale/conflicted
      // branch (see docs/design and the "many cards bounce back stale" motivation for this step).
      patch.status = "blocked";
      patch.body = appendNote(patch.body, "Blocked", `develop sync: ${syncOutcome.reason}`);
      await this._appendComment(
        taskId,
        "assembled-board",
        `Merge-develop enforcement could not complete automatically for ${branch}: ${syncOutcome.reason} ` +
          `The PR (${prUrl ?? "n/a"}) is still open but its branch has unresolved conflicts against origin/${this.baseBranch} -- manual resolution required before this card can proceed to review.`
      );
    }

    await this._updateAndBroadcast(taskId, patch);
  }

  /**
   * Enforcement step: every card that reaches an open PR must have origin/${this.baseBranch}
   * merged into its branch before it's left for a human, so a card doesn't bounce back to
   * in-progress purely because its branch went stale against develop while it sat in review.
   * Runs in the same worktree `_handlePass` is about to remove, right after the PR is opened.
   *
   * A clean merge (or a no-op when the branch already has everything on develop) just pushes
   * the result (or doesn't, if nothing changed) and returns `{ ok: true }`.
   *
   * A real conflict is never resolved mechanically -- no automatic take-ours/take-theirs, no
   * discarding either side. Instead it's handed back to the same agent that implemented the
   * card (`effectiveAgent`) as one more run phase, with the conflicted files and their conflict
   * markers in the prompt (see buildMergeConflictPromptFn / gitOps.mergeDevelop's conflict
   * shape). Only once that phase exits cleanly *and* a fresh check confirms every conflict is
   * actually resolved and committed does this push and return `{ ok: true }`; a crash, or an
   * agent that stops without fully resolving, returns `{ ok: false, reason }` instead -- the
   * caller surfaces that on the card rather than pushing a broken merge.
   *
   * Git-level failures unrelated to a real conflict (fetch/merge erroring for some other reason,
   * e.g. network trouble) degrade gracefully: logged and treated as best-effort skip (`{ ok:
   * true }`), the same "never fail the run over an infra hiccup" posture `_updateAndBroadcast`'s
   * commit step and `_openPullRequest` already take -- only a genuine, detected conflict (or a
   * failure to resolve one) is a reason to hold the card back.
   */
  async _syncBranchWithDevelop({ taskId, task, effectiveAgent, worktreeDir, branch, runLog }) {
    let mergeResult;
    try {
      await this.git.fetch({ worktreeDir });
      mergeResult = await this.git.mergeDevelop({ worktreeDir, baseBranch: this.baseBranch });
    } catch (err) {
      await this._logFinalize(taskId, runLog, `develop sync skipped: git fetch/merge failed: ${err.message}`);
      return { ok: true };
    }

    if (!mergeResult.conflicted) {
      if (!mergeResult.changed) {
        await this._logFinalize(taskId, runLog, `${branch} already up to date with origin/${this.baseBranch}.`);
        return { ok: true };
      }
      try {
        await this.git.push({ worktreeDir, branch });
      } catch (err) {
        return { ok: false, reason: `merged origin/${this.baseBranch} cleanly but push failed: ${err.message}` };
      }
      await this._logFinalize(taskId, runLog, `Merged origin/${this.baseBranch} into ${branch} (clean) and pushed.`);
      return { ok: true };
    }

    await this._logFinalize(
      taskId,
      runLog,
      `Merge conflicts against origin/${this.baseBranch} in: ${mergeResult.conflictedFiles.join(", ")} -- handing back to ${effectiveAgent} for resolution.`
    );

    const agentDef = this.loadAgentDefFn(effectiveAgent, { agentsDir: this.agentsDir });
    const allowedTools = this.resolveAllowedToolsFn(effectiveAgent, { agentsDir: this.agentsDir });
    const prompt = this.buildMergeConflictPromptFn({
      task,
      agentDef,
      baseBranch: this.baseBranch,
      branch,
      conflictedFiles: mergeResult.conflictedFiles,
      hunks: mergeResult.hunks
    });

    const result = await this._runPhase({
      taskId,
      task,
      phase: "merge-conflict",
      prompt,
      allowedTools,
      worktreeDir,
      model: agentDef.model,
      runLog
    });

    if (result.cancelled) {
      return { ok: true, skip: true };
    }
    if (result.timedOut) {
      return { ok: false, reason: `${effectiveAgent} agent's ${this._timeoutReason("merge-conflict resolution")}` };
    }
    if (result.exitCode !== 0) {
      return { ok: false, reason: `${effectiveAgent} agent's ${this._crashReason("merge-conflict resolution", result)}` };
    }

    const stillUnresolved = await this.git.mergeStatus({ worktreeDir });
    const dirty = await this.git.hasUncommittedChanges({ worktreeDir });
    if (stillUnresolved.length > 0 || dirty) {
      const detail = stillUnresolved.length > 0 ? stillUnresolved.join(", ") : "uncommitted merge state";
      return {
        ok: false,
        reason: `merge conflicts against origin/${this.baseBranch} were not fully resolved (${detail}) -- left for manual resolution, branch not pushed.`
      };
    }

    try {
      await this.git.push({ worktreeDir, branch });
    } catch (err) {
      return { ok: false, reason: `merge conflicts resolved but push failed: ${err.message}` };
    }
    await this._logFinalize(taskId, runLog, `Resolved merge conflicts against origin/${this.baseBranch} and pushed.`);
    return { ok: true };
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
