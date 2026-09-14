import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * WIP gate T-D (spec §5): the shared launch-boundary reservation. `cardLaunch.js`'s
 * `launchCardRun` is the one path both the Run button and the auto-launch poller launch
 * through -- this module is what turns that shared boundary into an atomic check-and-reserve
 * with a lease/owner, so the serial poller's own `hasActiveRuns()` (which only serializes its
 * own path) is no longer the only thing standing between two launches and the same remaining
 * capacity.
 *
 * A lease is keyed by (cardId, executionId, invocationId) -- the same identity triple
 * `usageLedger.js` uses, so a reservation and the ledger entries it eventually reconciles
 * against always line up. `executionId`/`invocationId` are unique per launch (minted by
 * `ensureExecutionId` and by the launch boundary itself respectively, never reused across
 * concurrent launches), so two DIFFERENT launches can never collide on the same lease file --
 * each gets its own, written via exclusive create (`wx`), and `listActiveReservations` simply
 * sums whatever lease files are currently unreleased. That is what makes the "two simultaneous
 * launches can't reserve the same capacity" property hold without needing a separate mutex: a
 * writer never has to read-then-decide against another writer's in-flight write, it just adds
 * its own immutable, uniquely-named fact to the ledger, and every reader's sum is always the
 * sum of every fact currently on disk.
 */

/** Thrown by `reserveLaunchSlot` when a lease already exists for this exact key. */
export class DuplicateReservationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DuplicateReservationError";
  }
}

function reservationDir(runsDir) {
  return path.join(runsDir, ".launch-reservations");
}

/** Path to one launch's reservation lease -- keyed identically to usageLedger.js's own triple. */
export function reservationLeasePath(runsDir, { cardId, executionId, invocationId }) {
  return path.join(reservationDir(runsDir), `${cardId}-exec${executionId}-inv${invocationId}.reservation.json`);
}

async function writeAtomic(filePath, data, { writeFileFn, mkdirFn, renameFn, unlinkFn }) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await mkdirFn(path.dirname(filePath), { recursive: true });
  await writeFileFn(tmpPath, JSON.stringify(data, null, 2), "utf8");
  try {
    await renameFn(tmpPath, filePath);
  } catch (err) {
    await unlinkFn(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Atomically reserves budget for one launch at the shared launch boundary. Never refuses a
 * launch itself (this card ships advisory/reservation-tracking only -- see the acceptance "Do
 * not" list); it always writes the lease and returns it. What IS refused, via
 * `DuplicateReservationError`, is reserving the identical (cardId, executionId, invocationId)
 * key twice -- that would double-book the same launch's own budget against itself, the one
 * case where "atomic" has to mean something stronger than "each call gets its own file".
 *
 * The exclusive-create (`wx`) write on the FINAL path (not a temp-then-rename) is what makes
 * the duplicate check atomic under concurrency: two racing calls for the same key can never
 * both observe "no lease yet" and both proceed to write, because the filesystem itself
 * arbitrates which `wx` wins.
 */
export async function reserveLaunchSlot({
  runsDir,
  cardId,
  executionId,
  invocationId,
  owner,
  reservedCostUsd,
  windows = [],
  reason = null,
  now = () => new Date(),
  writeFileFn = fs.writeFile,
  mkdirFn = fs.mkdir
}) {
  const filePath = reservationLeasePath(runsDir, { cardId, executionId, invocationId });
  const recordedAt = now().toISOString();
  const entry = {
    cardId,
    executionId,
    invocationId,
    owner,
    reservedCostUsd,
    windows,
    reason,
    released: false,
    releasedAt: null,
    outcome: null,
    recordedAt
  };
  await mkdirFn(path.dirname(filePath), { recursive: true });
  try {
    await writeFileFn(filePath, JSON.stringify(entry, null, 2), { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if (err && err.code === "EEXIST") {
      throw new DuplicateReservationError(
        `launch reservation: a lease already exists for ${cardId}/${executionId}/${invocationId}`
      );
    }
    throw err;
  }
  return entry;
}

/**
 * Marks a previously-reserved lease released, with the outcome it ended on (spec §5:
 * "reconcile on completion, crash or restart. Release reservations if launch or resource
 * acquisition fails."). Idempotent -- releasing an already-released lease again just
 * overwrites `outcome`/`releasedAt`, it never throws, since the caller (`cardLaunch.js`'s
 * completion/failure handling, or a later reconciliation sweep) cannot always tell which of
 * several release paths got there first. Returns `null`, never throwing, when no lease was
 * ever recorded for this key -- nothing to reconcile.
 */
export async function releaseReservation({
  runsDir,
  cardId,
  executionId,
  invocationId,
  outcome = null,
  now = () => new Date(),
  readFileFn = fs.readFile,
  writeFileFn = fs.writeFile,
  mkdirFn = fs.mkdir,
  renameFn = fs.rename,
  unlinkFn = fs.unlink
}) {
  const filePath = reservationLeasePath(runsDir, { cardId, executionId, invocationId });
  let existing;
  try {
    existing = JSON.parse(await readFileFn(filePath, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  const updated = { ...existing, released: true, outcome, releasedAt: now().toISOString() };
  await writeAtomic(filePath, updated, { writeFileFn, mkdirFn, renameFn, unlinkFn });
  return updated;
}

/** Every currently-unreleased lease across `runsDir`. `[]` when the reservation dir doesn't exist yet. */
export async function listActiveReservations({ runsDir, readdirFn = fs.readdir, readFileFn = fs.readFile }) {
  let names;
  try {
    names = await readdirFn(reservationDir(runsDir));
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const active = [];
  for (const name of names) {
    if (!name.endsWith(".reservation.json")) continue;
    let entry;
    try {
      entry = JSON.parse(await readFileFn(path.join(reservationDir(runsDir), name), "utf8"));
    } catch {
      continue; // mid-write or malformed -- never let one bad file crash a read of the whole ledger
    }
    if (entry && entry.released !== true) active.push(entry);
  }
  return active;
}

/** Total unspent reserved cost (USD) across a set of active reservations -- `reserved_unspent_cost` in spec §4's formula. */
export function sumActiveReservedCostUsd(reservations) {
  return reservations.reduce((sum, r) => sum + (typeof r.reservedCostUsd === "number" ? r.reservedCostUsd : 0), 0);
}

/**
 * Crash/restart reconciliation (spec §5): releases every active lease whose card is no longer
 * actually in flight, so a board restart (or a process that died between reserving and
 * releasing) can never leave the reserved budget permanently overstated. "Still in flight" is
 * exactly the same test the rest of the runner uses to decide whether a card has a live run --
 * `in-progress`/`validation` -- rather than re-deriving pid/log liveness here; `orphanReaper.js`
 * is what corrects a card's OWN status when a process actually died, and once that correction
 * lands (or if it never needed to, because the card genuinely finished/failed/was cancelled)
 * this sweep reclaims the reservation that decision left behind. A card the store no longer
 * knows about at all (deleted) is treated the same as "not in flight" -- there's nothing left
 * for the reservation to protect.
 */
export async function reconcileReservationsOnStartup({
  runsDir,
  store,
  now = () => new Date(),
  logger = console,
  liveStatuses = new Set(["in-progress", "validation"])
}) {
  const active = await listActiveReservations({ runsDir });
  const released = [];
  for (const reservation of active) {
    let task = null;
    try {
      task = await store.get(reservation.cardId);
    } catch {
      task = null;
    }
    if (task && liveStatuses.has(task.status)) continue;
    const outcome = { status: task ? "reconciled_not_running" : "reconciled_card_missing" };
    const result = await releaseReservation({
      runsDir,
      cardId: reservation.cardId,
      executionId: reservation.executionId,
      invocationId: reservation.invocationId,
      outcome,
      now
    });
    if (result) {
      released.push(result);
      logger.log(
        `launch-reservation: reconciled dangling lease for ${reservation.cardId}/${reservation.executionId}/${reservation.invocationId} -- ${outcome.status}`
      );
    }
  }
  return { released };
}
