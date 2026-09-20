import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * WIP gate T-E (T-0371, spec §8): one shared, EXCLUSIVE lease per constrained GPU/ComfyUI server,
 * acquired atomically alongside T-0370's admission/reservation at the same launch boundary
 * (`cardLaunch.js`'s `launchCardRun`). GPU is a separate currency from the token budget
 * `launchReservation.js` tracks: that module sums an ADDITIVE cost pool across many concurrent
 * reservations; this one enforces mutual exclusion -- at most ONE owner per `serverId` at a time,
 * matching the board's existing human-enforced "one GPU card at a time" rule.
 *
 * `docs/gpu-submission-audit.md` audits every path that can put work on the GPU today and why a
 * board-owned lease can only ever govern the one path the board itself launches (a board-launched
 * `assets`/`audio` card's implementer run) -- not a script or the ComfyUI UI used directly,
 * outside a board-launched run. `docs/gpu-lease.md` documents this module's design in full.
 *
 * A lease file's OWN EXISTENCE is the exclusivity signal -- there is no `released` flag to
 * inspect (contrast `launchReservation.js`, where a released lease is still a fact on disk
 * forever, for audit purposes, and only excluded by a status field): once released, the file is
 * unlinked outright, and unlinked is exactly the state a fresh acquire needs to succeed. This
 * keeps "is the server free" a single existence check with no ambiguous states to reconcile.
 */

/** Thrown by `acquireGpuLease` when the named server's lease is already held by anyone (including a re-acquire of the identical key). */
export class GpuLeaseHeldError extends Error {
  constructor(message, holder) {
    super(message);
    this.name = "GpuLeaseHeldError";
    this.holder = holder;
  }
}

/**
 * The one physical, constrained GPU box this repo has today (docs/gpu-submission-audit.md):
 * ComfyUI (8188), ACE-Step/Stable Audio (8002), and LoRA training (`accelerate`, no HTTP server)
 * all contend for the SAME card, so they share one `serverId` rather than one lease per port --
 * splitting by port would let two of them "each" hold their own lease while still fighting over
 * the one GPU underneath, exactly the failure this card exists to close.
 */
export const GPU_SERVER_ID = "comfyui-primary";

function gpuLeaseDir(runsDir) {
  return path.join(runsDir, ".gpu-leases");
}

/** Path to the one lease file for a given constrained GPU/ComfyUI server. */
export function gpuLeasePath(runsDir, serverId = GPU_SERVER_ID) {
  return path.join(gpuLeaseDir(runsDir), `${serverId}.gpu-lease.json`);
}

/**
 * Acquires the named server's lease for one launch. Written via a temp file linked atomically
 * into place (`fs.link`, mirroring `launchReservation.js`'s `reserveLaunchSlot`) -- the final path
 * never exists until the content behind it is complete, and `link` fails with `EEXIST` rather
 * than silently overwriting when a lease is already held, which is what makes "at most one holder
 * per server" atomic under concurrency: two racing acquires can never both observe "free" and
 * both proceed, since the filesystem itself arbitrates which `link` wins. Refuses a re-acquire of
 * the identical key too -- a lease is single-use until explicitly released, never idempotent on
 * the acquiring side (contrast `releaseGpuLease`, which IS idempotent).
 */
export async function acquireGpuLease({
  runsDir,
  serverId = GPU_SERVER_ID,
  cardId,
  executionId,
  invocationId,
  owner,
  reason = null,
  now = () => new Date(),
  writeFileFn = fs.writeFile,
  mkdirFn = fs.mkdir,
  linkFn = fs.link,
  unlinkFn = fs.unlink,
  readFileFn = fs.readFile
}) {
  const filePath = gpuLeasePath(runsDir, serverId);
  const entry = {
    serverId,
    cardId,
    executionId,
    invocationId,
    owner,
    reason,
    acquiredAt: now().toISOString()
  };
  await mkdirFn(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFileFn(tmpPath, JSON.stringify(entry, null, 2), "utf8");
  try {
    await linkFn(tmpPath, filePath);
  } catch (err) {
    if (err && err.code === "EEXIST") {
      let holder = null;
      try {
        holder = JSON.parse(await readFileFn(filePath, "utf8"));
      } catch {
        holder = null;
      }
      const holderDescription = holder ? `${holder.cardId}/${holder.executionId}/${holder.invocationId} (owner: ${holder.owner})` : "another launch";
      throw new GpuLeaseHeldError(`gpu lease: ${serverId} is already held by ${holderDescription}`, holder);
    }
    throw err;
  } finally {
    await unlinkFn(tmpPath).catch(() => {});
  }
  return entry;
}

/**
 * Releases the named server's lease -- but ONLY when it is currently held by the exact
 * (cardId, executionId, invocationId) passed in. A mismatched or absent lease returns `null`
 * rather than throwing: idempotent for the normal "release what I hold" case (calling this twice,
 * or after a crash already cleared it, is a no-op), and safe against a stale caller trying to
 * free a lease that has since moved to a different owner (e.g. a superseded decision path racing
 * with the one that actually launched) -- that call must never clear someone else's active lease.
 */
export async function releaseGpuLease({
  runsDir,
  serverId = GPU_SERVER_ID,
  cardId,
  executionId,
  invocationId,
  outcome = null,
  readFileFn = fs.readFile,
  unlinkFn = fs.unlink
}) {
  const filePath = gpuLeasePath(runsDir, serverId);
  let existing;
  try {
    existing = JSON.parse(await readFileFn(filePath, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  if (existing.cardId !== cardId || existing.executionId !== executionId || existing.invocationId !== invocationId) {
    return null;
  }
  await unlinkFn(filePath);
  return { ...existing, released: true, outcome };
}

/** The current holder of a server's lease, or `null` when it is free. */
export async function readGpuLease({ runsDir, serverId = GPU_SERVER_ID, readFileFn = fs.readFile }) {
  try {
    return JSON.parse(await readFileFn(gpuLeasePath(runsDir, serverId), "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Crash/board-restart reconciliation (acceptance: "after a crash or board restart, stale GPU
 * leases are reconciled against live processes"): releases every GPU lease whose owning card is
 * no longer actually in flight, using the identical liveness rule
 * `launchReservation.js`'s `reconcileReservationsOnStartup` uses (`in-progress`/`validation`
 * against the same task store) -- so a card that crashed loses its GPU lease and its token
 * reservation together, and a card genuinely still running keeps both (see
 * `gpuLease.test.js`'s "recover coherently together" case). Tolerant of a pool it can't fully
 * read, exactly like the token reservation's own startup follow-up: a single unreadable/malformed
 * lease file, or a `.gpu-leases` directory that can't be listed at all, is logged and left
 * exactly as found -- it must never be the reason a board process fails to start.
 */
export async function reconcileGpuLeasesOnStartup({
  runsDir,
  store,
  logger = console,
  liveStatuses = new Set(["in-progress", "validation"]),
  readdirFn = fs.readdir,
  readFileFn = fs.readFile,
  unlinkFn = fs.unlink
}) {
  let names;
  try {
    names = await readdirFn(gpuLeaseDir(runsDir));
  } catch (err) {
    if (err && err.code === "ENOENT") return { released: [] };
    logger.error(`gpu-lease: could not list the gpu lease pool at startup (${gpuLeaseDir(runsDir)}) -- leaving it untouched and continuing startup: ${err.message}`);
    return { released: [] };
  }

  const released = [];
  for (const name of names) {
    if (!name.endsWith(".gpu-lease.json")) continue;
    const filePath = path.join(gpuLeaseDir(runsDir), name);
    let entry;
    try {
      const parsed = JSON.parse(await readFileFn(filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.cardId !== "string") {
        throw new Error("gpu lease has an invalid or missing shape");
      }
      entry = parsed;
    } catch (err) {
      logger.error(`gpu-lease: lease file ${name} is unreadable or malformed at startup -- leaving it untouched for inspection: ${err.message}`);
      continue;
    }

    let task = null;
    try {
      task = await store.get(entry.cardId);
    } catch {
      task = null;
    }
    if (task && liveStatuses.has(task.status)) continue;

    try {
      await unlinkFn(filePath);
      released.push(entry);
      logger.log(
        `gpu-lease: reconciled dangling gpu lease for ${entry.serverId}/${entry.cardId}/${entry.executionId}/${entry.invocationId} -- card no longer running`
      );
    } catch (err) {
      logger.error(`gpu-lease: failed to release dangling gpu lease ${name}: ${err.message}`);
    }
  }
  return { released };
}

const ENABLE_VALUES = new Set(["1", "true", "on", "yes"]);

/**
 * Default OFF (acceptance: "with the default configuration no launch that happens today is
 * refused ... turning the lease on for the live board is left to a separate flag"), and
 * deliberately a SEPARATE env var from `WIP_GATE_ENFORCEMENT_ENABLED` -- GPU is its own currency
 * (acceptance: "tracked as its own currency, separate from token budgets"), so it is switched on
 * independently of the token-budget enforcement flag, not folded into it.
 */
export function gpuLeaseEnabledFromEnv() {
  return ENABLE_VALUES.has((process.env.GPU_LEASE_ENABLED ?? "").toLowerCase());
}
