import path from "node:path";
import { getPrState } from "./githubOps.js";
import { withTimeout } from "./boundedAwait.js";
import { needsApproval } from "../lib/approvalGate.js";
import { StaleWriteError } from "../lib/taskStore.js";
import { appendNote } from "./runOrchestrator.js";
import { applyTerminalStatusEffects } from "../server/httpApi.js";
import * as gitOps from "./gitOps.js";

const MERGE_RECONCILE_DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/**
 * T-0434: @DennieSeth merged #444 while the board was restarting, so the card sat in `review`
 * with the merge already on develop and nothing to notice. This module is what notices --
 * see docs/design/auto-done-on-merge.md for the full design.
 *
 * `review` is the ONLY status an observed MERGE auto-completes. That is deliberately narrow:
 * `_handlePass` (runOrchestrator.js) is the only place a card's `pr` field is ever set, and it
 * sets it in the same write that moves the card to `review` -- so under normal operation a PR
 * exists at all only once a card has already reached `review`, and a human only ever merges a
 * PR once they've looked at `review`. Any OTHER status carrying a MERGED PR is not a case to
 * complete silently -- see REPORT_ONLY_STATUSES.
 */
export const MERGEABLE_STATUSES = new Set(["review"]);

/**
 * Statuses where an observed MERGED PR is a surprise worth a human's attention rather than a
 * routine completion: a card still mid-run (`in-progress`/`validation`) or not yet started
 * (`backlog`/`ready`/`blocked`) has no business having a merged PR at all. `done`/`retired` are
 * deliberately excluded here -- those are already terminal and a MERGED PR behind them is
 * completely ordinary (every `done` card that ever shipped has one), not worth a word.
 */
const REPORT_ONLY_STATUSES = new Set(["in-progress", "validation", "backlog", "ready", "blocked"]);

/**
 * The only statuses worth spending a `gh pr view` call on at all -- `MERGEABLE_STATUSES` (where a
 * MERGED PR triggers the actual transition) union `REPORT_ONLY_STATUSES` (where a MERGED PR is
 * logged as a surprise). Every other status -- `done`, `retired`, and anything this module simply
 * doesn't recognize -- is terminal or irrelevant to a merge event, and is skipped *before* any
 * network call, not just before the eventual status check that follows a successful read. Reading
 * first and only noticing the status can't use it afterwards means re-polling GitHub for every
 * `done`/`retired` card that happens to still carry its old `pr` URL (every shipped card does) on
 * every single sweep, forever -- that IS "hammering the API" against AC #15, not a hypothetical.
 */
const ELIGIBLE_FOR_PR_READ_STATUSES = new Set([...MERGEABLE_STATUSES, ...REPORT_ONLY_STATUSES]);

/**
 * How many cards this module will read PR state for at once during a single `reconcileAll` pass.
 * A fixed, small bound sits between two failure modes a prior review caught: fully sequential (N
 * cards x `prReadTimeoutMs` each, which during a GitHub outage with a long `review` backlog can
 * run long enough to blow past the sweep interval or stall boot) and fully parallel (N simultaneous
 * `gh` subprocesses against a single, possibly rate-limited API -- the literal "hammering" AC #15
 * warns about). 4 is deliberately unremarkable: this module's own eligible set is already small by
 * construction (only `review` plus the report-only statuses, see `ELIGIBLE_FOR_PR_READ_STATUSES`
 * above), so this bound exists for the batch/outage tail, not the common case.
 */
export const DEFAULT_RECONCILE_CONCURRENCY = 4;

/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once -- see
 * DEFAULT_RECONCILE_CONCURRENCY for why this exists instead of a plain sequential loop or
 * `Promise.all`. Preserves `items`' order in the returned array regardless of completion order.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Sensible default: frequent enough that a card doesn't sit stranded in `review` for hours after a merge, cheap enough (one `gh pr view` per review card) to run indefinitely -- same order of magnitude as autoPullPoller.js's DEFAULT_AUTOPULL_INTERVAL_MS, which exists for the same "nothing catastrophic if this is a few minutes late" reason. */
export const DEFAULT_MERGE_RECONCILE_INTERVAL_MS = 5 * 60_000;

/** How long a single `gh pr view` is allowed to take before this card is treated as unreadable for this pass -- see boundedAwait.js. Bounded well under the sweep interval so one slow/rate-limited call can never make a tick overrun into the next one. */
const DEFAULT_PR_READ_TIMEOUT_MS = 8_000;

/** BOARD_MERGE_RECONCILE env var: master switch, default ON. */
export function mergeReconcileEnabledFromEnv() {
  return !MERGE_RECONCILE_DISABLE_VALUES.has((process.env.BOARD_MERGE_RECONCILE ?? "").toLowerCase());
}

/** BOARD_MERGE_RECONCILE_STARTUP env var: default ON. Independent of the sweep switch -- each recovery path must be disableable on its own (see createMergeReconciler's docstring). */
export function mergeReconcileStartupEnabledFromEnv() {
  return !MERGE_RECONCILE_DISABLE_VALUES.has((process.env.BOARD_MERGE_RECONCILE_STARTUP ?? "").toLowerCase());
}

/** BOARD_MERGE_RECONCILE_SWEEP env var: default ON. Independent of the startup switch. */
export function mergeReconcileSweepEnabledFromEnv() {
  return !MERGE_RECONCILE_DISABLE_VALUES.has((process.env.BOARD_MERGE_RECONCILE_SWEEP ?? "").toLowerCase());
}

/** BOARD_MERGE_RECONCILE_INTERVAL_MS env var: default DEFAULT_MERGE_RECONCILE_INTERVAL_MS. "0" is a valid, deliberate disable sentinel (distinct from garbage input, which falls back to the default). */
export function mergeReconcileIntervalMsFromEnv() {
  const raw = process.env.BOARD_MERGE_RECONCILE_INTERVAL_MS;
  if (raw === undefined || raw === "") return DEFAULT_MERGE_RECONCILE_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MERGE_RECONCILE_INTERVAL_MS;
}

/**
 * Commits the just-completed card the same way orphanReaper.js's commitReapedCard does (see its
 * own docstring for why this must never throw past a best-effort try/catch, and why db mode is
 * always a no-op here -- there is no tasks/*.md file to commit, the write above already landed
 * directly in the DB).
 */
async function commitMergedCard({ taskId, repoRoot, tasksDir, git, taskStoreKind }) {
  if (taskStoreKind === "db" || !repoRoot || !tasksDir || !git.autoCommitCardsOnCreateFromEnv()) return;
  try {
    const relativePath = path.relative(repoRoot, path.join(tasksDir, `${taskId}.md`));
    await git.commitTaskFile({
      repoRoot,
      filePath: relativePath,
      message: `chore(board): mark ${taskId} done (PR merged)`
    });
  } catch (err) {
    console.warn(`merge-reconciler: failed to commit ${taskId}'s done transition (leaving it untracked):`, err.message);
  }
}

/**
 * Reads a card's linked PR state, bounded so a hung/rate-limited GitHub call can never wedge a
 * sweep tick -- resolves to `null` (never throws) on timeout, a transport failure, or a
 * missing/renamed PR alike: every one of those is "could not be read" from this module's point
 * of view, and the caller's job is only to decide whether that's worth logging, never to guess.
 */
async function readPrState({ worktreeDir, prUrl, getPrStateFn, logger, timeoutMs }) {
  return withTimeout(() => getPrStateFn({ worktreeDir, prUrl }), {
    timeoutMs,
    logger,
    label: `merge-reconciler: gh pr view ${prUrl}`,
    fallback: () => null
  });
}

/**
 * Reconciles a single card against its linked PR's live state. Returns the updated task if this
 * call moved it to `done`, otherwise `null` -- including every "left exactly as it is" path:
 * no `pr` field, an unreadable PR, a PR that is not (yet) MERGED, a status this module is not
 * allowed to touch, a `requires_approval` card still unapproved, a PR whose head branch doesn't
 * match this card's own `branch` (see the shared-PR note below), or a write that lost a race
 * with a human.
 */
export async function reconcileCard({
  store,
  hub = null,
  task,
  repoRoot = null,
  tasksDir = null,
  git = gitOps,
  taskStoreKind = "fs",
  worktreeDir = repoRoot,
  getPrStateFn = getPrState,
  needsApprovalFn = needsApproval,
  logger = console,
  prReadTimeoutMs = DEFAULT_PR_READ_TIMEOUT_MS,
  orchestrator = null,
  restartCoordinator = null,
  applyTerminalStatusEffectsFn = applyTerminalStatusEffects
}) {
  if (!task.pr) return null;
  // See ELIGIBLE_FOR_PR_READ_STATUSES: a terminal/unrecognized status is skipped before the
  // network call, never after -- this is the fix for the "every done card gets re-polled forever"
  // defect, not merely a status check moved earlier for its own sake.
  if (!ELIGIBLE_FOR_PR_READ_STATUSES.has(task.status)) return null;

  const prData = await readPrState({ worktreeDir, prUrl: task.pr, getPrStateFn, logger, timeoutMs: prReadTimeoutMs });
  if (!prData) {
    logger.log(`merge-reconciler: card ${task.id}'s PR (${task.pr}) could not be read -- left untouched`);
    return null;
  }

  if (prData.state !== "MERGED") return null;

  // Several cards pointing at the same PR, or a card whose `pr` field points at a PR that
  // actually belongs to a different card, must never be transitioned on the strength of the
  // `pr` field alone: this is the one place we can tell, by checking the PR's actual head
  // branch against the branch THIS card's own run recorded. A mismatch means the link is
  // stale/wrong for this card -- leave it untouched and say why, rather than guessing.
  if (task.branch && prData.headRefName && task.branch !== prData.headRefName) {
    logger.log(
      `merge-reconciler: card ${task.id}'s linked PR (${task.pr}) head branch "${prData.headRefName}" does not ` +
        `match the card's own branch "${task.branch}" -- looks like a shared/misattributed PR link, left untouched`
    );
    return null;
  }

  if (REPORT_ONLY_STATUSES.has(task.status)) {
    logger.log(
      `merge-reconciler: card ${task.id} is "${task.status}" but its linked PR (${task.pr}) is already MERGED -- ` +
        `only "${[...MERGEABLE_STATUSES].join(", ")}" auto-completes on a merge, so this is being reported, ` +
        `not auto-completed. A human should look at ${task.id}.`
    );
    return null;
  }

  if (!MERGEABLE_STATUSES.has(task.status)) {
    // done/retired: already terminal. A card already done stays done (an idempotent re-run of
    // this exact reconciliation must never re-fire done's side effects); a card a human has
    // since moved to retired keeps that human decision -- this module only ever moves a card
    // towards done once, from review, and never second-guesses anything past that.
    return null;
  }

  if (needsApprovalFn(task)) {
    logger.log(
      `merge-reconciler: card ${task.id} requires human approval before done (conduct.md's requires_approval ` +
        `gate) -- its PR (${task.pr}) merged, but it stays parked in review until a human approves it`
    );
    return null;
  }

  let updated;
  try {
    updated = await store.update(
      task.id,
      { status: "done", body: appendNote(task.body, "Merge reconciler", `PR ${task.pr} observed MERGED -- auto-completed.`) },
      { expected: { status: "review" } }
    );
  } catch (err) {
    if (err instanceof StaleWriteError) {
      logger.log(
        `merge-reconciler: card ${task.id} changed status before the done write landed (likely a human moving ` +
          `it at the same time) -- skipped, no conflicting write`
      );
      return null;
    }
    throw err;
  }

  logger.log(`merge-reconciler: card ${task.id} -> done (PR ${task.pr} observed MERGED)`);
  if (hub && typeof hub.broadcast === "function") {
    hub.broadcast({ type: "changed", id: task.id, task: updated });
  }
  await commitMergedCard({ taskId: task.id, repoRoot, tasksDir, git, taskStoreKind });
  // This reconciler is a third route to `done`, alongside the PATCH {status: "done"} and
  // comment-approval routes in httpApi.js -- all three must fire the exact same terminal-status
  // follow-through (the artifact-cache purge and the develop-branch deploy pull), or a card
  // completed by a merge the board noticed on its own would land in `done` with none of it, the
  // same divergence shape docs/board-invariants.md AP-8 warns about (PULL-1).
  await applyTerminalStatusEffectsFn({ orchestrator, restartCoordinator, id: task.id, status: updated.status, repoRoot });
  return updated;
}

/**
 * Backstop for a merge observed while nothing was watching -- the T-0434 case this module
 * exists for. Two independently-disableable entry points cover the two ways a merge can be
 * missed, mirroring orphanReaper.js's reapOnStartup/sweepOnce split:
 *
 * - `reconcileOnStartup`: runs once, at boot, against every card currently in the store --
 *   recovers a merge that happened for however long the board was down, restarting, or simply
 *   not deployed yet to run this check at all. Deliberately sweeps the FULL backlog, not just
 *   cards created since this feature shipped: the bug it exists to fix (T-0434) IS a card stuck
 *   in `review` from an old, missed merge, so a time cutoff would leave exactly that case
 *   unfixed. This is safe to run unbounded because of MERGEABLE_STATUSES, not despite it -- the
 *   only cards this can ever touch are the ones still sitting in `review` with a `pr` link, and
 *   it only ever moves one of those towards `done`, the status a human already reached by
 *   merging. It can never resurrect a `done`/`retired` card or revisit one twice.
 * - `sweepOnce` (run on an interval via `start`/`stop`): the periodic companion for a merge that
 *   happens while the board stays up continuously -- see DEFAULT_MERGE_RECONCILE_INTERVAL_MS for
 *   why that interval is "frequent enough, cheap enough" rather than live.
 *
 * Both call the exact same per-card `reconcileCard` logic -- there is no separate "startup mode"
 * special case, unlike orphanReaper.js's pid-liveness distinction, because merge detection reads
 * external GitHub state plus the card's own fields, never this process's own in-memory run
 * tracking. That is also why each path is independently sufficient: disabling one changes
 * nothing about what the other recovers.
 */
export function createMergeReconciler({
  store,
  hub = null,
  enabled = mergeReconcileEnabledFromEnv(),
  startupEnabled = mergeReconcileStartupEnabledFromEnv(),
  sweepEnabled = mergeReconcileSweepEnabledFromEnv(),
  intervalMs = mergeReconcileIntervalMsFromEnv(),
  repoRoot = null,
  tasksDir = null,
  taskStoreKind = "fs",
  git = gitOps,
  worktreeDir = repoRoot,
  getPrStateFn = getPrState,
  needsApprovalFn = needsApproval,
  logger = console,
  prReadTimeoutMs = DEFAULT_PR_READ_TIMEOUT_MS,
  reconcileConcurrency = DEFAULT_RECONCILE_CONCURRENCY,
  orchestrator = null,
  restartCoordinator = null,
  applyTerminalStatusEffectsFn = applyTerminalStatusEffects
}) {
  let timer = null;
  // Shared by reconcileOnStartup and sweepOnce (not just the interval timer): a slow pass --
  // GitHub degraded, a large eligible batch -- must never overlap ANOTHER pass reading and
  // writing the same cards concurrently, regardless of which entry point triggered it. Without
  // this, a tick that outlives its own interval (exactly the "overlapping sweeps accumulate, each
  // spawning gh subprocesses" failure a prior review caught) piles up instead of being skipped.
  let reconcileInFlight = null;

  async function reconcileAll() {
    const tasks = await store.list();
    const eligible = tasks.filter((task) => task.pr && ELIGIBLE_FOR_PR_READ_STATUSES.has(task.status));
    const completed = [];
    await mapWithConcurrency(eligible, reconcileConcurrency, async (task) => {
      try {
        const updated = await reconcileCard({
          store,
          hub,
          task,
          repoRoot,
          tasksDir,
          git,
          taskStoreKind,
          worktreeDir,
          getPrStateFn,
          needsApprovalFn,
          logger,
          prReadTimeoutMs,
          orchestrator,
          restartCoordinator,
          applyTerminalStatusEffectsFn
        });
        if (updated) completed.push(task.id);
      } catch (err) {
        logger.error(`merge-reconciler: unexpected error reconciling card ${task.id}: ${err.message}`);
      }
    });
    return completed;
  }

  async function reconcileAllGuarded() {
    if (reconcileInFlight) {
      logger.log("merge-reconciler: a reconciliation pass is already in flight -- skipping this trigger rather than overlapping it");
      return [];
    }
    reconcileInFlight = reconcileAll();
    try {
      return await reconcileInFlight;
    } finally {
      reconcileInFlight = null;
    }
  }

  async function reconcileOnStartup() {
    if (!enabled || !startupEnabled) return [];
    return reconcileAllGuarded();
  }

  async function sweepOnce() {
    if (!enabled || !sweepEnabled) return [];
    return reconcileAllGuarded();
  }

  function start() {
    if (!enabled || !sweepEnabled || intervalMs <= 0 || timer) return;
    timer = setInterval(() => {
      sweepOnce().catch((err) => logger.error(`merge-reconciler: sweep failed: ${err.message}`));
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    reconcileOnStartup,
    sweepOnce,
    start,
    stop,
    get enabled() {
      return enabled;
    }
  };
}
