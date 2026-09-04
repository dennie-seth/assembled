import fsp from "node:fs/promises";
import { isPidAlive } from "./runState.js";

/**
 * Cross-process ownership of a board database.
 *
 * The orphan reaper's guards were all built for ONE process: #322's ownership check reads the
 * orchestrator's in-memory `activeCardIds`, and #336's launch grace lives in a Map held by the
 * reaper instance. Neither can see a *second* board instance bound to the same database -- and on
 * 2026-09-04 that is exactly what reaped six live cards.
 *
 * How a second instance happens, without anyone intending it: `claudeCliRunner.js`'s
 * AGENT_ENV_ALLOWLIST forwards BOARD_TASK_STORE and BOARD_DB_PATH to child `claude` CLIs on
 * purpose (PR #230), so an agent's own API calls address the same board the service does. When
 * that agent runs `npx vitest` as part of its card, the test process inherits them too --
 * `startBoardServer` then defaults `taskStoreKind` to "db", `openDb()` falls through to
 * DEFAULT_DB_PATH, and the suite is holding the live board's database. `startBoardServer` calls
 * `orphanReaper.reapOnStartup()`, which in a fresh process has an empty `activeCardIds`, finds no
 * runstate in its throwaway tmp `.runs` directory, and concludes every live card is dead.
 *
 * The lock is deliberately advisory and reaping-only. It does NOT stop a second process reading
 * or writing cards -- worktrees, scripts and tests legitimately do that, and a hard lock would
 * break them. It gates exactly one capability: the authority to declare someone else's run dead.
 * A process that does not own the board still serves its API normally; it just never reaps.
 *
 * Failure posture is fail-SAFE, meaning "not owner": if the lock cannot be read or written, the
 * reaper stays off. A board that briefly cannot reap recovers on the next restart; a board that
 * wrongly reaps destroys a live run's card state, which is the failure we are actually paying to
 * avoid. The one exception is a lock we cannot parse -- a corrupt file would otherwise disable
 * reaping forever, so it is treated as unheld and overwritten.
 */

/** The lock lives beside the database file it guards -- no extra env var, no extra directory. */
export function boardOwnerLockPath(dbPath) {
  return `${dbPath}.owner.json`;
}

/**
 * Claims the right to reap cards in the board at `lockPath`, returning `{ owned, heldBy, reason }`.
 *
 * `owned` is the only thing callers should branch on. `heldBy` is the pid found in an existing
 * lock (live or stale) and is for logging. Never throws.
 */
export async function acquireBoardOwnership({
  lockPath,
  pid = process.pid,
  isPidAliveFn = isPidAlive,
  readFileFn = (p) => fsp.readFile(p, "utf8"),
  writeFileFn = (p, data) => fsp.writeFile(p, data, "utf8"),
  logger = console,
  now = () => new Date()
} = {}) {
  let heldBy = null;
  let existingRaw = null;

  try {
    existingRaw = await readFileFn(lockPath);
  } catch {
    // No lock file (ENOENT) is the common, healthy case: first boot, or the previous owner
    // exited cleanly. Anything else unreadable is treated the same way -- we fall through to
    // trying to write, and a write failure is what turns into "not owned" below.
    existingRaw = null;
  }

  if (existingRaw !== null) {
    let parsed = null;
    try {
      parsed = JSON.parse(existingRaw);
    } catch {
      parsed = null;
    }

    if (parsed && Number.isInteger(parsed.pid)) {
      heldBy = parsed.pid;
      if (heldBy !== pid && isPidAliveFn(heldBy)) {
        // The live board is running. We are the intruder -- almost always a test process that
        // inherited BOARD_TASK_STORE=db. Leave the owner's record exactly as it is.
        logger.log(
          `board-ownership: this process (pid ${pid}) does NOT own ${lockPath} -- ` +
            `it is held by live pid ${heldBy}. The orphan reaper is DISABLED here; ` +
            `only the owning board process may reap its cards.`
        );
        return { owned: false, heldBy, reason: "held-by-live-pid" };
      }
    }
  }

  const record = JSON.stringify({ pid, acquiredAt: now().toISOString() });
  try {
    await writeFileFn(lockPath, record);
  } catch (err) {
    // Fail safe: without a lock we cannot prove we are the owner, so we decline the capability
    // rather than assume it.
    logger.log(
      `board-ownership: could not claim ${lockPath} (${err.message}) -- ` +
        `treating this process as NOT the owner; the orphan reaper stays disabled.`
    );
    return { owned: false, heldBy, reason: "lock-unwritable" };
  }

  if (heldBy !== null && heldBy !== pid) {
    logger.log(
      `board-ownership: took over ${lockPath} from stale pid ${heldBy} (no longer running) -- ` +
        `pid ${pid} now owns this board and may reap.`
    );
    return { owned: true, heldBy, reason: "stale-lock-taken-over" };
  }

  logger.log(`board-ownership: pid ${pid} owns ${lockPath} -- orphan reaping enabled.`);
  return { owned: true, heldBy, reason: heldBy === pid ? "reacquired" : "acquired" };
}
