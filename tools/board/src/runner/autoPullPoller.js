import { isBehindOrigin, pullDevelop } from "./gitOps.js";

const AUTOPULL_DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** Sensible default: frequent enough that a merged PR doesn't sit un-deployed for hours, cheap enough (one `git fetch` + a no-op `rev-list` on most ticks) to run indefinitely. */
export const DEFAULT_AUTOPULL_INTERVAL_MS = 5 * 60_000;

/** BOARD_AUTOPULL env var: default ON; set to "0"/"false"/"off"/"no" (any case) to disable the periodic poller, mirroring AUTO_RESTART_ON_PULL/AUTO_RECOVER_ORPHANED_RUNS. */
export function boardAutopullEnabledFromEnv() {
  return !AUTOPULL_DISABLE_VALUES.has((process.env.BOARD_AUTOPULL ?? "").toLowerCase());
}

/** BOARD_AUTOPULL_INTERVAL_MS env var: default DEFAULT_AUTOPULL_INTERVAL_MS. "0" is a valid, deliberate disable sentinel (distinct from garbage input, which falls back to the default rather than silently disabling). */
export function autoPullIntervalMsFromEnv() {
  const raw = process.env.BOARD_AUTOPULL_INTERVAL_MS;
  if (raw === undefined || raw === "") return DEFAULT_AUTOPULL_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AUTOPULL_INTERVAL_MS;
}

/**
 * Periodic companion to the Done-triggered `pullDevelop` in httpApi.js's `handlePatchTask`: an
 * idle board with no card reaching Done never runs that path, so a merged PR can sit un-deployed
 * indefinitely (the gap docs/board-invariants.md's PULL-1 fixed for the Done trigger specifically
 * doesn't cover). This reuses the exact same `pullDevelop` + `restartCoordinator` machinery on a
 * timer instead of reinventing pull/restart safety here.
 *
 * Every tick: if a card run is active, the tick is skipped entirely -- no fetch, no pull, nothing
 * -- and the next tick (or the run's own eventual `notifyIdle`) picks it back up; this is
 * deliberately more conservative than the Done path, which always pulls and only defers the
 * *restart*, because a poller tick has no card-completion event forcing it to run right now. Only
 * once idle does it fetch and check `isBehindOrigin` -- cheap, and avoids invoking `pullDevelop`'s
 * merge machinery on ticks where nothing changed. `restartCoordinator.notifyPulled` reads
 * `hasActiveRuns()` fresh *after* the pull completes (not the pre-pull value used to gate the
 * tick), so a run that started mid-pull still gets the same idle-guarded deferral the Done path
 * relies on -- this is a safety net for that race, not the primary guard.
 */
export function createAutoPullPoller({
  repoRoot,
  branch = "develop",
  orchestrator,
  restartCoordinator,
  enabled = boardAutopullEnabledFromEnv(),
  intervalMs = autoPullIntervalMsFromEnv(),
  git = { isBehindOrigin, pullDevelop },
  logger = console
}) {
  const effectivelyEnabled = enabled && intervalMs > 0 && Boolean(repoRoot);
  let timer = null;

  function hasActiveRuns() {
    return Boolean(orchestrator && orchestrator.hasActiveRuns && orchestrator.hasActiveRuns());
  }

  async function tick() {
    if (!effectivelyEnabled) return null;

    if (hasActiveRuns()) {
      logger.log("assembled-board: auto-pull tick skipped -- a card run is active");
      return null;
    }

    const behind = await git.isBehindOrigin({ repoRoot, branch });
    if (!behind) return null;

    const result = await git.pullDevelop({ repoRoot, branch });
    if (result.advanced) {
      logger.log(`assembled-board: auto-pull advanced ${branch} ${result.before.slice(0, 7)} -> ${result.after.slice(0, 7)}`);
      if (restartCoordinator) {
        restartCoordinator.notifyPulled({ hasActiveRuns: hasActiveRuns() });
      }
    }
    return result;
  }

  function start() {
    if (!effectivelyEnabled || timer) return;
    timer = setInterval(() => {
      tick().catch((err) => logger.error(`assembled-board: auto-pull tick failed: ${err.message}`));
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
    tick,
    start,
    stop,
    get enabled() {
      return effectivelyEnabled;
    }
  };
}
