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

/**
 * Thrown by `listActiveReservations` when the capacity pool cannot be fully, reliably read --
 * either the reservation directory itself couldn't be listed (for a reason other than it simply
 * not existing yet), or one of its lease files is unreadable/mid-write/malformed. T-0370 fix
 * round (Codex review, finding 1): "an unreadable, mid-write or malformed lease never silently
 * disappears from the capacity pool, and a failure to list the pool never becomes an empty
 * pool" -- every caller of `listActiveReservations` must treat this as an indeterminate read
 * (an explicit hold), never coerce it into `[]`.
 */
export class ReservationPoolReadError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReservationPoolReadError";
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
 * Written via a temp file that is fully flushed to disk FIRST, then atomically linked into its
 * final path (`fs.link`, not `fs.rename`) -- T-0370 fix round (Codex review, finding 1): "leases
 * are written atomically so a crash cannot leave a half-written one". `link` gives both
 * properties `rename` alone can't: the final path never exists until the content behind it is
 * complete (no half-written file, since the temp file it's a hard link to was already fully
 * written and fsync'd by `writeFileFn` before the link is attempted), AND it fails with `EEXIST`
 * rather than silently overwriting when the final path already exists -- which is what makes the
 * duplicate check atomic under concurrency: two racing calls for the same key can never both
 * observe "no lease yet" and both proceed to publish, because the filesystem itself arbitrates
 * which `link` wins. The temp file is always removed afterward regardless of outcome -- once
 * linked, its own name is no longer needed (the final path is a second, independent directory
 * entry pointing at the same data).
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
  // T-0370 fix round 2 finding 3: "prior spend subtracted exactly once, under one documented
  // convention" -- this lease stores the REMAINING (already net of prior spend) `reservedCostUsd`,
  // alongside the lifetime-charged baseline it was computed against. A reader (`remainingReservedCostUsd`)
  // subtracts only spend charged AFTER this baseline, never the lifetime spend a second time. See
  // docs/wip-gate-admission.md.
  chargedAtReservationUsd = 0,
  now = () => new Date(),
  writeFileFn = fs.writeFile,
  mkdirFn = fs.mkdir,
  linkFn = fs.link,
  unlinkFn = fs.unlink
}) {
  const filePath = reservationLeasePath(runsDir, { cardId, executionId, invocationId });
  const recordedAt = now().toISOString();
  const entry = {
    cardId,
    executionId,
    invocationId,
    owner,
    reservedCostUsd,
    chargedAtReservationUsd,
    windows,
    reason,
    released: false,
    releasedAt: null,
    outcome: null,
    recordedAt
  };
  await mkdirFn(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFileFn(tmpPath, JSON.stringify(entry, null, 2), "utf8");
  try {
    await linkFn(tmpPath, filePath);
  } catch (err) {
    if (err && err.code === "EEXIST") {
      throw new DuplicateReservationError(
        `launch reservation: a lease already exists for ${cardId}/${executionId}/${invocationId}`
      );
    }
    throw err;
  } finally {
    await unlinkFn(tmpPath).catch(() => {});
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

/**
 * Whether a parsed lease is a shape `listActiveReservations` can trust (T-0370 fix round 2 finding
 * 5: "the admission-time lease reader validates every parsed lease"). Rejects a non-object (JSON
 * `null`, a number, an array/string), a missing or non-string identity field, an identity that
 * doesn't match the file it was read from (the file name IS the lease's key -- a mismatch means
 * either corruption or a lease that was copied/renamed into place, neither of which this reader
 * can trust), and a `released` that isn't a boolean. Deliberately silent on `reservedCostUsd`'s
 * own validity -- that is a SEPARATE concern (`isKnownReservedCostUsd`, handled by the cost-summing
 * helpers), since an unreleased lease with an unknown cost is still a structurally valid lease.
 */
function isValidLeaseShape(entry, fileName) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (typeof entry.cardId !== "string" || typeof entry.executionId !== "string" || typeof entry.invocationId !== "string") return false;
  if (typeof entry.released !== "boolean") return false;
  const expectedFileName = `${entry.cardId}-exec${entry.executionId}-inv${entry.invocationId}.reservation.json`;
  return expectedFileName === fileName;
}

/**
 * Shared directory walk behind both `listActiveReservations` and
 * `reconcileReservationsOnStartup` -- the two callers differ only in what they do when the pool
 * can't be fully read, never in how they read it. `onListError`/`onEntryError` decide that: throw
 * to make the failure an explicit hold (admission time), or log-and-return-a-fallback to tolerate
 * it (startup, T-0370 follow-up). `[]` from the walk itself only when the reservation dir has
 * never been created (nothing has ever been reserved) -- that case is never a failure either way.
 */
async function readReservationEntries({ runsDir, readdirFn, readFileFn, onListError, onEntryError }) {
  let names;
  try {
    names = await readdirFn(reservationDir(runsDir));
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    return onListError(err);
  }
  const active = [];
  for (const name of names) {
    if (!name.endsWith(".reservation.json")) continue;
    let entry;
    try {
      const parsed = JSON.parse(await readFileFn(path.join(reservationDir(runsDir), name), "utf8"));
      if (!isValidLeaseShape(parsed, name)) {
        throw new Error(`lease has an invalid or mismatched shape`);
      }
      entry = parsed;
    } catch (err) {
      const fallback = onEntryError(name, err);
      if (fallback !== undefined) active.push(fallback);
      continue;
    }
    if (entry.released !== true) active.push(entry);
  }
  return active;
}

/**
 * Every currently-unreleased lease across `runsDir`. `[]` only when the reservation dir has never
 * been created (nothing has ever been reserved). Any OTHER failure to list the directory, or any
 * lease file that can't be read and parsed, throws `ReservationPoolReadError` rather than
 * silently excluding it from the pool (T-0370 fix round, Codex review finding 1) -- a caller that
 * can't prove the pool is empty must never treat it as empty. This is the admission-time contract;
 * it is unchanged by the startup follow-up below (`reconcileReservationsOnStartup` reads the pool
 * with its own, tolerant handlers instead of calling this function).
 */
export async function listActiveReservations({ runsDir, readdirFn = fs.readdir, readFileFn = fs.readFile }) {
  return readReservationEntries({
    runsDir,
    readdirFn,
    readFileFn,
    onListError: (err) => {
      throw new ReservationPoolReadError(`launch reservation: could not list the reservation pool: ${err.message}`);
    },
    onEntryError: (name, err) => {
      throw new ReservationPoolReadError(`launch reservation: lease file ${name} is unreadable or malformed -- ${err.message}`);
    }
  });
}

/** Whether a lease's own `reservedCostUsd` is a validly-recorded amount -- finite and non-negative. Anything else (missing, a string, negative, `NaN`/`Infinity`) is an explicit UNKNOWN cost, never a silent 0 (T-0370 fix round 2 finding 5). */
function isKnownReservedCostUsd(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Total unspent reserved cost (USD) across a set of active reservations -- `reserved_unspent_cost`
 * in spec §4's formula. Returns `null` -- never a silently-under-counted number -- the instant any
 * ONE active reservation's own `reservedCostUsd` is unknown (T-0370 fix round 2 finding 5: "in
 * every helper that sums lease costs, never 0" -- a launch whose own cost estimate was unknown at
 * reservation time still counts as unknown, not free, to every later admission).
 */
export function sumActiveReservedCostUsd(reservations) {
  let total = 0;
  for (const r of reservations) {
    if (!isKnownReservedCostUsd(r.reservedCostUsd)) return null;
    total += r.reservedCostUsd;
  }
  return total;
}

/**
 * A single active reservation's REMAINING future cost -- its raw `reservedCostUsd` minus whatever
 * has been charged AFTER the baseline (`chargedAtReservationUsd`) it was written against (T-0370
 * fix round, Codex review finding 6, and fix round 2 finding 3: "prior spend subtracted exactly
 * once" -- `reservedCostUsd` is already net of the spend known at write time, so subtracting the
 * execution's full lifetime spend again here would double-count it; only spend charged SINCE the
 * lease was written reduces it further). Never negative (an execution that ran over its own
 * reservation still contributes 0 more to what's held back from everyone else, not a negative
 * "freed up" amount).
 *
 * Returns `null` -- never a silently-substituted 0 -- when `reservedCostUsd` itself is not a
 * known amount (T-0370 fix round 2 finding 5): a launch whose own estimate was unknown at
 * reservation time must count as an explicit unknown to every later admission, not as free
 * capacity. An unknown `spentUsd` (a read failure upstream) assumes nothing spent yet -- the
 * conservative direction for THIS quantity; the caller reading that spend itself goes
 * indeterminate rather than substituting 0 on its own read failure.
 */
export function remainingReservedCostUsd(reservation, spentUsd) {
  if (!isKnownReservedCostUsd(reservation.reservedCostUsd)) return null;
  const baseline = typeof reservation.chargedAtReservationUsd === "number" ? reservation.chargedAtReservationUsd : 0;
  const spent = typeof spentUsd === "number" ? spentUsd : 0;
  const spentSinceBaseline = Math.max(0, spent - baseline);
  return Math.max(0, reservation.reservedCostUsd - spentSinceBaseline);
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
 *
 * T-0370 follow-up: this is the ONE caller that tolerates a pool it can't fully read. An
 * unreadable/malformed lease file, or a `.launch-reservations` directory that can't be listed at
 * all, must never stop the board from starting -- a single bad file left behind by a previous
 * crash would otherwise fail every future startup, including the auto-pull restart on merge. Each
 * is logged and left exactly as found on disk for a human to inspect; every OTHER lease in the
 * pool is still reconciled (per-file resilience, not all-or-nothing). This does NOT weaken
 * `listActiveReservations`'s own admission-time contract above -- an admission decision still
 * sees an unreadable pool as an explicit hold; only startup's reaction to the same failure
 * differs.
 */
export async function reconcileReservationsOnStartup({
  runsDir,
  store,
  now = () => new Date(),
  logger = console,
  liveStatuses = new Set(["in-progress", "validation"]),
  readdirFn = fs.readdir,
  readFileFn = fs.readFile
}) {
  const active = await readReservationEntries({
    runsDir,
    readdirFn,
    readFileFn,
    onListError: (err) => {
      logger.error(
        `launch-reservation: could not list the reservation pool at startup (${reservationDir(runsDir)}) -- leaving it untouched and continuing startup: ${err.message}`
      );
      return [];
    },
    onEntryError: (name, err) => {
      logger.error(
        `launch-reservation: lease file ${name} is unreadable or malformed at startup -- leaving it untouched for inspection: ${err.message}`
      );
      return undefined;
    }
  });
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
