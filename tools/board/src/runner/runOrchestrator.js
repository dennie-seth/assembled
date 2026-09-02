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
import { computeFailureSignature } from "./failureSignature.js";
import { buildBlockerReport, formatBlockerReportComment } from "./blockerReport.js";
import { findExistingRemediationCard, draftRemediationCard } from "../lib/escalationRemediation.js";
import { createCard as createCardDefault } from "./cardCreation.js";
import { checkAcceptancePreflight } from "./acceptancePreflight.js";
import { checkCapabilityPreflight } from "./capabilityPreflight.js";
import {
  assertRunnerMayApply,
  needsApproval,
  parkedForApprovalComment,
  PARKED_STATUS
} from "../lib/approvalGate.js";

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

/**
 * Per-agent phase budgets, for agents whose legitimate work does not fit the default.
 * One entry per agent; adding or tuning one is a one-line change.
 *
 * `assets` (240 min) -- GPU generation and LoRA training. T-0228 (Arm A) was killed
 * twice at exactly 40 minutes while making steady progress: 1136 and 661 logged events,
 * max inter-event gap 120s / 287s (nowhere near the 8-minute inactivity threshold), and
 * 26/26 ComfyUI executions succeeded with no errors and no OOM. Its stack (SDXL + style
 * LoRA + IP-Adapter + OpenPose ControlNet) measured ~240s per generation, and the card's
 * own acceptance criteria mandate up to 8 attempts -- ~32 minutes of GPU alone, before
 * setup, tests, image inspection, descend/index and provenance. The card was
 * unsatisfiable inside the default bound.
 *
 * 120 was not enough. T-0229 (Arm B) trains a per-character LoRA before it generates, and
 * that was measured at ~7 min to load the 6.94 GB SDXL checkpoint (~32 MB/s over the WSL 9p
 * /mnt/f mount), ~3 min to build the network and cache latents, and ~117 min of training
 * (72 steps at ~98 s/step) -- ~127 min before generation starts, ~175 min for the whole arm.
 * It was killed at step 65/72. 240 clears that with ~65 min of slack, which matters because
 * the checkpoint read rate varies run to run; 180 would have left about five minutes.
 *
 * Raising the bound is much safer than it once was: §23-a's no-progress abort escalates
 * a repeating failure without burning the budget (and since T-0229 it compares the worktree's
 * git state rather than the reviewer's prose, so it actually fires), and
 * DEFAULT_INACTIVITY_TIMEOUT_MS still catches a genuine hang in 8 minutes regardless of what
 * this says. The phase timeout is no longer the load-bearing hang defence -- it is a cost
 * ceiling.
 *
 * Note this keys on the agent the PHASE runs as, not the card's agent: an assets card's
 * reviewer phase runs as `reviewer` and keeps the default, since it verifies output
 * rather than generating it.
 */
export const PHASE_TIMEOUT_MS_BY_AGENT = Object.freeze({
  assets: 240 * 60 * 1000
});

const PHASE_TIMEOUT_ENV_VAR = "PHASE_TIMEOUT_MS";

/**
 * Phase budget for *agent*, in precedence order:
 *   1. `override` -- the process-wide PHASE_TIMEOUT_MS escape hatch (or an injected
 *      value in tests). Applies to every agent, deliberately: it exists to override.
 *   2. `byAgent` -- the per-agent budget above.
 *   3. `fallback` -- DEFAULT_PHASE_TIMEOUT_MS.
 *
 * A non-positive or unparseable override is ignored rather than trusted, so a typo in the
 * env var cannot silently disable the watchdog.
 */
export function resolvePhaseTimeoutMs(
  agent,
  { override = null, byAgent = PHASE_TIMEOUT_MS_BY_AGENT, fallback = DEFAULT_PHASE_TIMEOUT_MS } = {}
) {
  const parsedOverride = Number(override);
  if (override !== null && override !== undefined && Number.isFinite(parsedOverride) && parsedOverride > 0) {
    return parsedOverride;
  }
  // Own-property check only: an agent literally named "constructor" or "toString" must
  // not pick up a function off Object.prototype and be compared as a number.
  const perAgent =
    typeof agent === "string" && byAgent && Object.prototype.hasOwnProperty.call(byAgent, agent)
      ? Number(byAgent[agent])
      : NaN;
  if (Number.isFinite(perAgent) && perAgent > 0) return perAgent;
  return fallback;
}

/** PHASE_TIMEOUT_MS env var: a global override across every agent, or null when unset/invalid. */
function phaseTimeoutOverrideFromEnv() {
  const raw = process.env[PHASE_TIMEOUT_ENV_VAR];
  const parsed = Number(raw);
  return raw && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Finer-grained belt-and-suspenders companion to DEFAULT_PHASE_TIMEOUT_MS, sized specifically for
 * the stdin-hang bug (T-0117: a live run wedged 30+ minutes). Root cause, confirmed by inspecting
 * the installed `@anthropic-ai/claude-code` CLI bundle (v2.1.78) directly: every Bash-tool command
 * the agent runs is spawned by the CLI's own internal shell-execution code as
 * `stdio: isNested ? ["pipe","pipe","pipe"] : ["pipe", snapshotFd, snapshotFd]` -- stdin is always
 * a fresh, unwritten, never-closed OS pipe, never "ignore"/"inherit". A bare `grep pattern`,
 * `read`, or `cat` with no input redirect blocks on that pipe forever. This is entirely internal
 * to the CLI's own tool-execution machinery -- the board only spawns the outer `claude -p` process
 * once per phase (see ClaudeCliRunner.start()'s own stdio: ["ignore", ...], which only prevents
 * *that* process's own startup stdin probe from hanging) and has no spawn-option reach into what
 * the CLI does internally per tool call. See `.claude/rules/conduct.md` for the agent-facing
 * convention (`</dev/null` on any command that might read stdin) this can't itself enforce.
 *
 * Since the board can't close that inner stdin, this instead watches for the run going completely
 * silent -- re-armed on every raw stdout chunk (see _runPhase) -- and treats
 * inactivityTimeoutMs of dead air as wedged, killing the process group well under
 * DEFAULT_PHASE_TIMEOUT_MS's 40-minute ceiling. 8 minutes is deliberately generous relative to
 * legitimate quiet stretches observed in this repo's phases (verifyRouter.js's from-scratch
 * `cmake --build` / `pip install -e ".[dev]"` are both well under that with no output gap anywhere
 * near this size) while still being far tighter than the phase timeout. Unlike a phase timeout
 * (always a hard block, see DEFAULT_PHASE_TIMEOUT_MS), an inactivity timeout during the
 * implementer or reviewer phase is treated as a retryable FAIL -- see _runAttempt -- since a
 * stdin-hang is a one-off incident in a single tool call, not evidence the whole approach is stuck
 * the way exceeding the full phase budget is.
 */
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 8 * 60 * 1000;

const INACTIVITY_TIMEOUT_ENV_VAR = "INACTIVITY_TIMEOUT_MS";

/** INACTIVITY_TIMEOUT_MS env var: overrides DEFAULT_INACTIVITY_TIMEOUT_MS when set to a positive number. */
function inactivityTimeoutMsFromEnv() {
  const raw = process.env[INACTIVITY_TIMEOUT_ENV_VAR];
  const parsed = Number(raw);
  return raw && Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INACTIVITY_TIMEOUT_MS;
}

/**
 * Bounded retry window for `gh pr create` (GraphQL) on a PASS, before falling back to the REST
 * API -- sized off the 2026-08-17 incident where GraphQL alone returned "HTTP 503 ...
 * api.github.com/graphql" for several minutes while REST stayed reachable (reviewer PASSed
 * T-0117, PR-open failed, and the failure was silently swallowed -- a human had to notice the
 * card stuck in `review` with no PR). 4 attempts, doubling from PR_OPEN_BACKOFF_BASE_MS and
 * capped at PR_OPEN_BACKOFF_MAX_MS, totals at most ~1+2+4=7s of backoff -- long enough to ride
 * out a brief blip, short enough not to hang a run over a real outage before trying REST.
 */
export const PR_OPEN_GRAPHQL_MAX_ATTEMPTS = 4;
export const PR_OPEN_BACKOFF_BASE_MS = 1000;
export const PR_OPEN_BACKOFF_MAX_MS = 8000;

/**
 * Smaller retry budget for the REST fallback itself -- REST stayed up throughout the incident
 * that motivated this, so this is just insurance against a brief blip in REST too, not a second
 * full retry cycle.
 */
export const PR_OPEN_REST_MAX_ATTEMPTS = 2;

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
    phaseTimeoutMs = phaseTimeoutOverrideFromEnv(),
    phaseTimeoutsByAgent = PHASE_TIMEOUT_MS_BY_AGENT,
    inactivityTimeoutMs = inactivityTimeoutMsFromEnv(),
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
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onIdle = () => {}
  }) {
    this.store = store;
    this.hub = hub;
    this.runner = runner;
    this.git = git;
    this.github = github;
    this.autoOpenPr = autoOpenPr;
    this.autoCaptureUncommitted = autoCaptureUncommitted;
    // Global escape hatch (PHASE_TIMEOUT_MS, or injected). null = defer to the per-agent map.
    this.phaseTimeoutOverrideMs = phaseTimeoutMs ?? null;
    this.phaseTimeoutsByAgent = phaseTimeoutsByAgent;
    this.inactivityTimeoutMs = inactivityTimeoutMs;
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
    this.sleepFn = sleepFn;
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
    // The runner half of the human direction-approval gate (approvalGate.js): no automated
    // write may complete a card whose deliverable a human still has to sign off on. This is
    // the chokepoint every orchestrator write passes through, which is why the check lives
    // here rather than at each call site -- a future run path that sets `done` gets the guard
    // for free instead of having to remember it. See docs/board-invariants.md AP-2.
    if (patch && patch.status === "done") {
      assertRunnerMayApply(await this.store.get(taskId), patch);
    }

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

    // Pre-flight: verify the card has a parseable ## Acceptance checklist before running an
    // implementer. For agent:null cards this runs after the planner has expanded the spec; for
    // pre-assigned cards it runs immediately. Root cause from T-0186: 6 of 16 sampled rework
    // cycles were caused solely by a missing Acceptance section — implementation correct but
    // reviewer FAILed on the absent checklist. Catching this here saves one implementer LLM
    // call + one reviewer LLM call per underspecified card (see acceptancePreflight.js).
    //
    // Skip for blocked re-runs: the card was already validated once; blocking it again on a
    // missing Acceptance section would prevent legitimate recovery runs (the Blocked note
    // appended to the body doesn't add an Acceptance section, so a previously-valid card
    // that was blocked mid-run would be permanently un-runnable).
    if (task.status !== "blocked") {
      const preFlightTask = await this.store.get(taskId);
      const preflight = checkAcceptancePreflight(preFlightTask);
      if (!preflight.ok) {
        await this._blocked(taskId, preflight.message);
        return;
      }

      // Pre-flight (HANDOFF §23-b): checks the AC's actionable claims against the assigned
      // agent's tool grants and against external capabilities/resources it names (a ComfyUI
      // checkpoint/LoRA/custom node, a service endpoint) -- before the implementer child process
      // is spawned. Precedents this exists to catch before burning implementer/GPU time: T-0212
      // (assets.md tilde-vs-absolute python grant gap), T-0222 (AC required "open a PR", never
      // satisfiable by any implementer agent), T-0193 (ten FAILs on a missing reviewer grant).
      // Same fail-fast/blocked path as the acceptance-checklist preflight above -- a capability
      // gap is exactly as much a genuine blocker as a missing Acceptance section is.
      const capabilityPreflight = checkCapabilityPreflight(preFlightTask, effectiveAgent, {
        agentsDir: this.agentsDir,
        resolveAllowedToolsFn: this.resolveAllowedToolsFn
      });
      if (!capabilityPreflight.ok) {
        await this._blocked(taskId, capabilityPreflight.message);
        return;
      }
    }

    let currentReused = reused;
    const attemptRecords = [];
    // Tracks the previous attempt's failure signature (§23-a) so two consecutive attempts that
    // fail for the identical, unfixable reason abort the loop immediately instead of burning the
    // remaining MAX_AUTO_RETRY_ATTEMPTS slots on repeats -- see _handleFailValidation/
    // _escalateIfGenuineBlocker below for how the abort is surfaced.
    let previousSignature = null;
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

      // Inactivity timeouts are excluded from signature comparison (see _inactivityVerdict's
      // `synthetic` docstring): their reason text is generic by construction, so two in a row
      // isn't evidence of a repeating, unfixable blocker the way a genuine reviewer FAIL is.
      //
      // The signature is computed from the worktree's git state, not the reviewer's notes --
      // see failureSignature.js for why (T-0229 burned all five slots on eight FAILs the
      // reviewer itself called byte-identical, because its notes carry an attempt counter).
      const treeState = verdict.synthetic ? null : await this._readTreeState(worktreeDir);
      const signature = computeFailureSignature({
        phase: verdict.phase,
        verdict: verdict.verdict,
        state: treeState
      });
      const noProgress = signature !== null && previousSignature !== null && signature === previousSignature;
      attemptRecords.push({ attempt, notes: verdict.notes, events, signature });

      const isFinalAttempt = attempt >= MAX_AUTO_RETRY_ATTEMPTS;
      const stopping = isFinalAttempt || noProgress;
      await this._handleFailValidation(taskId, verdict, attempt, /* retrying */ !stopping, { noProgress, signature });
      if (stopping) {
        await this._escalateIfGenuineBlocker(taskId, attemptRecords, runLog, { noProgress, repeatedSignature: noProgress ? signature : null });
        return;
      }

      // Every attempt after the first resumes the same worktree/branch, regardless of
      // whether addWorktree itself had to reuse it (a first attempt can start fresh).
      currentReused = true;
      if (signature !== null) previousSignature = signature;
    }
  }

  /**
   * Worktree git state for the no-progress signature, or null if it cannot be read.
   *
   * Never throws: a git failure here must not take down an otherwise-fine run. Returning null
   * makes the signature null, which is never compared -- so the loop falls back to running the
   * full retry cap rather than risking a false abort on a card that might be progressing.
   */
  async _readTreeState(worktreeDir) {
    if (typeof this.git.readTreeState !== "function") return null;
    try {
      return await this.git.readTreeState({ worktreeDir });
    } catch {
      return null;
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
      agent: effectiveAgent,
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
      if (implementerResult.timeoutKind === "inactivity") {
        return { stop: false, verdict: this._inactivityVerdict("implementer"), events: implementerResult.events };
      }
      await this._blocked(taskId, this._timeoutReason("implementer", "phase", effectiveAgent));
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
      agent: "reviewer",
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
      if (reviewerResult.timeoutKind === "inactivity") {
        return {
          stop: false,
          verdict: this._inactivityVerdict("reviewer"),
          events: [...implementerResult.events, ...reviewerResult.events]
        };
      }
      await this._blocked(taskId, this._timeoutReason("reviewer", "phase", "reviewer"));
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

    return { stop: false, verdict: { ...verdict, phase: verdict.phase ?? "reviewer" }, events: [...implementerResult.events, ...reviewerResult.events] };
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
      await this._blocked(taskId, this._timeoutReason("planner", plannerResult.timeoutKind));
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

  async _runPhase({ taskId, task, phase, agent, prompt, allowedTools, worktreeDir, model, runLog }) {
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

    // Inactivity watchdog (T-0117 stdin-hang hardening): re-armed on every raw stdout chunk, so a
    // run that goes completely silent for inactivityTimeoutMs is treated as wedged and killed
    // minutes in, rather than waiting out the full DEFAULT_PHASE_TIMEOUT_MS ceiling -- see that
    // constant's docstring for the confirmed root cause (the CLI's own Bash-tool child processes
    // always get a stdin pipe the board can't close). A no-arg armInactivityTimer() call always
    // clears any previous timer first, so only the most recent chunk's deadline is ever live.
    let inactivityTimer;
    let resolveInactivity;
    const inactivityPromise = new Promise((resolve) => {
      resolveInactivity = resolve;
    });
    const armInactivityTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        resolveInactivity({ exitCode: null, signal: null, spawnError: null, timedOut: true, timeoutKind: "inactivity" });
      }, this.inactivityTimeoutMs);
      if (typeof inactivityTimer.unref === "function") inactivityTimer.unref();
    };
    armInactivityTimer();

    const onStdoutData = (chunk) => {
      armInactivityTimer();
      parser.push(chunk);
    };
    if (child.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", onStdoutData);
    }

    // Root-cause fix for T-0185: a hung grandchild (e.g. a headless Godot test that never calls
    // `get_tree().quit()`) previously kept this `await` pending forever, since the parent
    // `claude` child stays alive right along with it -- see DEFAULT_PHASE_TIMEOUT_MS's docstring.
    let timeoutTimer;
    const exitPromise = new Promise((resolve) => {
      // A spawn failure (e.g. ENOENT) can fire before we get here -- the writeRunStateFn
      // await above is a real window for it -- in which case ClaudeCliRunner.start() has
      // already captured it onto `run.spawnError` (its own synchronous 'error' listener
      // never misses it). Check that first so a fast failure doesn't wait for an 'error'
      // event that already came and went.
      if (run.spawnError) {
        resolve({ exitCode: null, signal: null, spawnError: run.spawnError, timedOut: false });
        return;
      }
      child.once("exit", (code, sig) => resolve({ exitCode: code, signal: sig, spawnError: null, timedOut: false }));
      child.once("error", (err) => resolve({ exitCode: null, signal: null, spawnError: err, timedOut: false }));
    });
    const timeoutPromise = new Promise((resolve) => {
      timeoutTimer = setTimeout(
        () => resolve({ exitCode: null, signal: null, spawnError: null, timedOut: true, timeoutKind: "phase" }),
        this._phaseTimeoutMsFor(agent)
      );
      if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();
    });

    const result = await Promise.race([exitPromise, timeoutPromise, inactivityPromise]);
    clearTimeout(timeoutTimer);
    clearTimeout(inactivityTimer);

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

  /** Phase budget for the agent this phase runs as -- see resolvePhaseTimeoutMs for precedence. */
  _phaseTimeoutMsFor(agent) {
    return resolvePhaseTimeoutMs(agent, {
      override: this.phaseTimeoutOverrideMs,
      byAgent: this.phaseTimeoutsByAgent
    });
  }

  /** Human-readable reason for a phase terminated by the phase timeout or the inactivity watchdog. */
  _timeoutReason(phase, kind = "phase", agent = null) {
    if (kind === "inactivity") {
      const minutes = Math.round(this.inactivityTimeoutMs / 60_000);
      return `${phase} run went silent for ${minutes} minute${minutes === 1 ? "" : "s"} with no new output and was terminated -- likely a stdin-hang or other hung child process (e.g. a bare grep/read/cat with no input redirect)`;
    }
    // Deliberately does NOT claim a hang. The phase watchdog fires on elapsed wall-clock
    // alone and cannot tell a slow-but-progressing run from a stuck one -- T-0228 was
    // killed twice as a "likely hung subprocess" while 26/26 of its GPU generations were
    // succeeding, and that wording is what sent the diagnosis down the wrong path. The
    // inactivity watchdog above and §23-a's no-progress abort are the hang defences; this
    // one is a budget ceiling, so it reports the budget and leaves the cause open.
    const minutes = Math.round(this._phaseTimeoutMsFor(agent) / 60_000);
    const forAgent = agent ? ` for the ${agent} agent` : "";
    return `${phase} run exceeded its ${minutes}-minute phase budget${forAgent} and was terminated. This is a budget ceiling, not a diagnosis -- the run may simply need longer than the budget allows. Check the run log for steady output before assuming it was stuck; if the work legitimately needs more time, raise this agent's entry in PHASE_TIMEOUT_MS_BY_AGENT.`;
  }

  /**
   * Synthetic FAIL verdict for an inactivity-timed-out implementer/reviewer phase -- feeds the
   * normal auto-retry loop instead of hard-blocking, since a stdin-hang is a one-off tool-call
   * incident, not evidence the whole attempt is unrecoverable. `synthetic: true` opts this out of
   * §23-a's no-progress signature comparison (see _runCardInWorktree): its reason text is the
   * same generic string every time by construction (same phase + same configured timeout), so
   * treating repeats as "no progress" would defeat the whole point of retrying it -- a stdin-hang
   * is exactly the kind of flaky, non-reproducible failure that's likely to clear on a plain
   * retry, unlike a deterministic reviewer FAIL repeating the same finding.
   */
  _inactivityVerdict(phase) {
    return { verdict: "FAIL", notes: this._timeoutReason(phase, "inactivity"), phase, synthetic: true };
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

  /**
   * `(run N of MAX)` suffix on every FAIL note -- the attempt-count visibility the auto-retry loop
   * needs on the card. `noProgress` (§23-a) takes priority over the plain cap-reached suffix: it
   * names the repeated failure signature and states outright that the loop stopped itself early,
   * not because attempts ran out -- distinct wording from the exhausted-cap case on purpose, so a
   * human reading the card never has to guess which one happened.
   */
  _failNoteText(verdict, attempt, capped, { noProgress = false, signature } = {}) {
    const progress = `(run ${attempt} of ${MAX_AUTO_RETRY_ATTEMPTS})`;
    let suffix = "";
    if (noProgress) {
      suffix =
        ` Auto-retry loop aborted: no progress -- this attempt's failure signature (${signature}) matches ` +
        "the previous attempt's. Blocked for human review; retries were not exhausted.";
    } else if (capped) {
      suffix = " Auto-retry limit reached -- blocked for human review.";
    }
    return `${verdict.notes}\n\n${progress}${suffix}`;
  }

  /**
   * Records a FAIL verdict. `retrying` (true for every attempt but the last, and false for a
   * no-progress abort regardless of attempt count) keeps the card at `status: "in-progress"` --
   * the same status a live run shows -- since the auto-retry loop is about to re-invoke the
   * implementer itself; a stopping attempt instead moves the card to `blocked` for a human, with
   * a note explaining why the loop stopped (cap reached, or no progress -- see `_failNoteText`).
   */
  async _handleFailValidation(taskId, verdict, attempt, retrying, { noProgress = false, signature } = {}) {
    const current = await this.store.get(taskId);
    await this._updateAndBroadcast(taskId, {
      status: retrying ? "in-progress" : "blocked",
      body: appendNote(current.body, "Validation: FAIL", this._failNoteText(verdict, attempt, !retrying, { noProgress, signature }))
    });
  }

  /**
   * Escalation step, fired once at the exhaustion boundary of the auto-retry loop (the 5th
   * consecutive FAIL that just set the card to `blocked` -- see docs/design/escalation-workflow.md).
   * Also fires early, before the cap is reached, when the retry loop detects no progress (§23-a):
   * two consecutive attempts hashed to the identical failure signature (`noProgress`/
   * `repeatedSignature`, threaded through from `_runCardInWorktree`) -- buildBlockerReport folds
   * that into the report's `abortReason` so the comment/remediation card name the repeated
   * signature and say explicitly the loop stopped for no progress, not exhaustion.
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
  async _escalateIfGenuineBlocker(taskId, attemptRecords, runLog, { noProgress = false, repeatedSignature = null } = {}) {
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
      const report = buildBlockerReport({ task, attemptRecords, attemptCount: attemptRecords.length, noProgress, repeatedSignature });
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

    const prUrl = await this._openPullRequest({ taskId, task, worktreeDir, branch, verdict, runLog, commit });

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

    // Human direction-approval gate (approvalGate.js, docs/board-invariants.md AP-1/AP-3): a
    // card flagged `requires_approval` has now produced its artifact and passed review, but
    // "produced" is not "approved". `review` is already where a PASS settles -- what was
    // missing is any signal that this particular card is *parked* on a human verdict rather
    // than waiting on a PR merge, and any record of the verdict when it comes. The comment is
    // that signal, and it names both exits so a human never has to go looking for the ritual.
    //
    // Deliberately posted after the status write, and only when the card actually settled into
    // the parked status: a card that ended up `blocked` by the develop-sync failure above has a
    // different, more urgent thing to say, and is not parked on anything.
    if (patch.status === PARKED_STATUS && needsApproval(current)) {
      await this._appendComment(taskId, "assembled-board", parkedForApprovalComment(taskId));
    }
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
      agent: effectiveAgent,
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
      return { ok: false, reason: `${effectiveAgent} agent's ${this._timeoutReason("merge-conflict resolution", result.timeoutKind, effectiveAgent)}` };
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
   * Finalize step: opens (or reuses) a GitHub PR for the just-pushed branch via the `gh` CLI.
   * gh missing/unauthenticated, or a disabled autoOpenPr flag, just skip PR creation and log why
   * (unchanged from before -- these are environment/config states, not GitHub outages). A `gh pr
   * create` (GraphQL) failure is classified (see githubOps.classifyGhError): "already-exists"
   * resolves via findExistingPr instead of erroring; "transient" (5xx, GraphQL outage, rate
   * limiting) retries with backoff and then falls back to the REST API, which stayed up during
   * the 2026-08-17 GraphQL-only outage that motivated this; "terminal" (auth/validation) fails
   * immediately since retrying or falling back would just fail the same way. If every avenue is
   * exhausted, this never returns silently -- see _recordPrOpenFailure. Never fails the run or
   * blocks the card either way. Returns the PR URL on success, or null when no PR was opened.
   */
  async _openPullRequest({ taskId, task, worktreeDir, branch, verdict, runLog, commit }) {
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

    const existing = await this.github.findExistingPr({ worktreeDir, branch });
    if (existing) {
      await this._logFinalize(taskId, runLog, `PR already exists, reusing: ${existing}`);
      return existing;
    }

    const title = buildPrTitle({ task });
    const body = buildPrBody({ task, verdict });
    const createArgs = { worktreeDir, base: this.baseBranch, head: branch, title, body };

    try {
      const url = await this._createPrWithRetry({ taskId, runLog, ...createArgs });
      await this._logFinalize(taskId, runLog, `Opened PR: ${url}`);
      return url;
    } catch (graphqlErr) {
      const resolved = await this._resolveAlreadyExists({ taskId, worktreeDir, branch, runLog, err: graphqlErr });
      if (resolved !== undefined) return resolved;

      if (graphqlErr.ghClassification !== "transient") {
        return this._recordPrOpenFailure({ taskId, branch, commit, runLog, reason: graphqlErr.message });
      }

      await this._logFinalize(
        taskId,
        runLog,
        `gh pr create exhausted ${PR_OPEN_GRAPHQL_MAX_ATTEMPTS} attempts (${graphqlErr.message}) -- falling back to the REST API.`
      );

      try {
        const url = await this._createPrRestWithRetry({ taskId, runLog, ...createArgs });
        await this._logFinalize(taskId, runLog, `Opened PR via REST fallback: ${url}`);
        return url;
      } catch (restErr) {
        const resolvedRest = await this._resolveAlreadyExists({ taskId, worktreeDir, branch, runLog, err: restErr });
        if (resolvedRest !== undefined) return resolvedRest;

        return this._recordPrOpenFailure({
          taskId,
          branch,
          commit,
          runLog,
          reason: `GraphQL failed (${graphqlErr.message}); REST fallback also failed (${restErr.message})`
        });
      }
    }
  }

  /** Retries `gh pr create` (GraphQL) through transient failures; throws the classified error once attempts are exhausted or the failure isn't transient. */
  async _createPrWithRetry({ taskId, runLog, worktreeDir, base, head, title, body }) {
    let lastErr;
    for (let attempt = 1; attempt <= PR_OPEN_GRAPHQL_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.github.createPr({ worktreeDir, base, head, title, body });
      } catch (err) {
        lastErr = err;
        if (err.ghClassification !== "transient" || attempt === PR_OPEN_GRAPHQL_MAX_ATTEMPTS) throw err;
        const delay = Math.min(PR_OPEN_BACKOFF_BASE_MS * 2 ** (attempt - 1), PR_OPEN_BACKOFF_MAX_MS);
        await this._logFinalize(
          taskId,
          runLog,
          `gh pr create failed transiently (attempt ${attempt}/${PR_OPEN_GRAPHQL_MAX_ATTEMPTS}): ${err.message} -- retrying in ${delay}ms.`
        );
        await this.sleepFn(delay);
      }
    }
    throw lastErr;
  }

  /** Same retry shape as _createPrWithRetry, scoped to the smaller REST fallback budget. */
  async _createPrRestWithRetry({ taskId, runLog, worktreeDir, base, head, title, body }) {
    let lastErr;
    for (let attempt = 1; attempt <= PR_OPEN_REST_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.github.createPrRest({ worktreeDir, base, head, title, body });
      } catch (err) {
        lastErr = err;
        if (err.ghClassification !== "transient" || attempt === PR_OPEN_REST_MAX_ATTEMPTS) throw err;
        const delay = Math.min(PR_OPEN_BACKOFF_BASE_MS * 2 ** (attempt - 1), PR_OPEN_BACKOFF_MAX_MS);
        await this._logFinalize(
          taskId,
          runLog,
          `REST PR-open fallback failed transiently (attempt ${attempt}/${PR_OPEN_REST_MAX_ATTEMPTS}): ${err.message} -- retrying in ${delay}ms.`
        );
        await this.sleepFn(delay);
      }
    }
    throw lastErr;
  }

  /**
   * When a createPr/createPrRest call fails with ghClassification "already-exists", gh has told
   * us a PR is already open for this branch -- idempotent success, not an error. Looks it up
   * (findExistingPr already falls back to REST itself if GraphQL is what's down) and returns its
   * URL. Returns `undefined` (not null -- null is a valid "genuinely couldn't find it" outcome)
   * when `err` isn't an already-exists error at all, so the caller can tell "not applicable" apart
   * from "looked, found nothing".
   */
  async _resolveAlreadyExists({ taskId, worktreeDir, branch, runLog, err }) {
    if (err.ghClassification !== "already-exists") return undefined;
    const found = await this.github.findExistingPr({ worktreeDir, branch });
    if (found) {
      await this._logFinalize(taskId, runLog, `gh reported the PR already exists; reusing: ${found}`);
      return found;
    }
    return null;
  }

  /**
   * Ultimate PR-open failure: GraphQL retries (and, for transient failures, the REST fallback)
   * are both exhausted. Root-cause fix for the T-0117 incident -- the old behavior just logged
   * `gh pr create failed` to the run log and left the card in `review` with `pr: null`, with
   * nothing on the card itself to say why, so a human had to go dig through run logs to notice.
   * This still leaves the card in `review` (unchanged status/pr shape from before) -- `review`
   * is one of runCard()'s own accepted starting statuses, so a later re-run retries PR-open
   * without any new machinery -- but now appends a comment identifying exactly what happened
   * (reviewer PASSed, branch pushed at `commit`, PR-open failed and why) so it's never a silent
   * dead end.
   */
  async _recordPrOpenFailure({ taskId, branch, commit, runLog, reason }) {
    await this._logFinalize(taskId, runLog, `PR not opened: gh pr create failed after retries + REST fallback: ${reason}`);
    await this._appendComment(
      taskId,
      "assembled-board",
      `Reviewer PASSed and \`${branch}\` was pushed at \`${commit}\`, but PR-open failed after retries and the REST ` +
        `fallback (${reason}). This looks like a GitHub outage or transient failure, not a problem with the card's ` +
        `work -- re-running this card will retry PR-open, or open it manually with ` +
        `\`gh pr create --base ${this.baseBranch} --head ${branch}\`.`
    );
    return null;
  }

  async _logFinalize(taskId, runLog, message) {
    const event = { type: "finalize", message };
    await runLog.append(event);
    this.hub.broadcast({ type: "run-event", id: taskId, phase: "finalize", event });
  }
}
