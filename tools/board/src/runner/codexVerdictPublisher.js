import { promises as fsp } from "node:fs";
import path from "node:path";
import { readVerdictEntries as defaultReadVerdictEntries, appendVerdictEntry as defaultAppendVerdictEntry, verdictArchiveDir } from "../lib/verdictArchive.js";
import { validateCodexVerdictPayload } from "./codexVerdictSchema.js";
import { isPidAlive as defaultIsPidAlive } from "./runState.js";

/**
 * T-0460: the deterministic publisher. Ordinary code, not the model -- the model's own output
 * (a `codex exec` run's structured JSON) only ever reaches this function as plain data on
 * `runResult.payload`; there is no path from model output to a filesystem write that doesn't go
 * through the identity/schema/head checks below. The function itself grants nothing: its return
 * value is a verdict-archive entry, never a merge flag, a status transition, or a protected-flag
 * change -- see this file's own "ordinary, deterministic code" test for what that rules out.
 *
 * Reuses `verdictArchive.js` (the board's existing exactly-once-per-card append machinery, see
 * `tools/board/src/lib/verdictArchive.js` -- the same file `runOrchestrator.js`'s
 * `_handlePass`/`_handleFailValidation` already call) rather than inventing a second verdict
 * store: that is "reuses the board's existing machinery" for T-0460's own acceptance criterion.
 */

const HEADING_PREFIX = "Codex Review";

function defaultNow() {
  return new Date().toISOString();
}

function renderText({ reason, detail, payload }) {
  const lines = [];
  if (reason) {
    lines.push(`Reason: ${reason}`);
  }
  if (detail !== undefined) {
    lines.push(`Detail: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  if (payload) {
    lines.push(`Acceptance criteria version: ${payload.acceptanceCriteriaVersion}`);
    lines.push(`Checks performed: ${payload.checksPerformed.join(", ") || "(none)"}`);
    if (payload.findings.length > 0) {
      lines.push("Findings:");
      for (const finding of payload.findings) {
        lines.push(`- ${finding.file}:${finding.line} -- ${finding.evidence}`);
      }
    } else {
      lines.push("Findings: none");
    }
    if (payload.limitations.length > 0) {
      lines.push(`Limitations: ${payload.limitations.join("; ")}`);
    }
  }
  return lines.join("\n");
}

/** Path to the durable delivery record for one (taskId, deliveryId) -- exported for tests that need to construct a stale/crashed claim directly, the same way `launchReservation.js` exports `reservationLeasePath` for the same reason. */
export function deliveryMarkerPath(tasksDir, taskId, deliveryId) {
  return path.join(verdictArchiveDir(tasksDir), `${taskId}.${deliveryId}.delivered`);
}

/**
 * Atomically creates `markerPath` containing `content`, via the same durable technique
 * `launchReservation.js` uses (`reserveLaunchSlot`'s docstring): write the full content to a temp
 * file first, then `fs.link` it into place. `link` fails `EEXIST` rather than overwriting when
 * the target already exists -- the OS arbitrates which of several racing callers wins, not this
 * process's own bookkeeping -- and the target never exists in a half-written state, since the
 * temp file behind it was already complete before the link was attempted.
 */
async function createMarkerAtomic(markerPath, content, { writeFileFn, mkdirFn, linkFn, unlinkFn }) {
  await mkdirFn(path.dirname(markerPath), { recursive: true });
  const tmpPath = `${markerPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFileFn(tmpPath, JSON.stringify(content), "utf8");
  try {
    await linkFn(tmpPath, markerPath);
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") return false;
    throw err;
  } finally {
    await unlinkFn(tmpPath).catch(() => {});
  }
}

/** Overwrites an already-claimed marker with its final content. Best-effort: a failure here is exactly the "process death after append but before completion marking" case the recovery path below is built to handle on the next delivery attempt. */
async function overwriteMarkerAtomic(markerPath, content, { writeFileFn, mkdirFn, renameFn, unlinkFn }) {
  await mkdirFn(path.dirname(markerPath), { recursive: true });
  const tmpPath = `${markerPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFileFn(tmpPath, JSON.stringify(content), "utf8");
  try {
    await renameFn(tmpPath, markerPath);
  } catch (err) {
    await unlinkFn(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Reads the marker's raw (unparsed) content -- the exact bytes the stale-reclaim recovery path
 * below re-verifies immediately before its destructive unlink (FIX ROUND 3, human comment (b)).
 * Returning the raw string, not the parsed object, is what lets the caller compare two reads for
 * byte-for-byte identity later without caring which fields happen to differ.
 */
async function readMarkerRaw(markerPath, { readFileFn }) {
  try {
    return await readFileFn(markerPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/** Bounds the stale-claim reclaim loop below. Each non-returning iteration proves it removed a
 * genuinely dead claim before looping, so only a pathological number of simultaneous racers could
 * ever approach this -- it exists as a hard backstop against an unbounded loop, not a limit this
 * card's own tests (at most a handful of concurrent callers) should ever come close to. */
const MAX_CLAIM_RECOVERY_ATTEMPTS = 25;

/**
 * The real exactly-once primitive. Originally fixed for T-0460's "FIX ROUND" P2 finding (the
 * pre-fix mechanism created an exclusive marker BEFORE appending and never recovered it if the
 * append failed or the process died before completing) by making the marker a durable,
 * recoverable delivery record rather than a one-shot flag -- but that first fix recovered a stale
 * claim through a SECOND exclusive marker (`<marker>.takeover`), which turned out to carry the
 * identical defect one level up (FIX ROUND 2, human comment (a)): the `.takeover` marker's mere
 * existence proved a takeover was CLAIMED, never that it FINISHED, so a crash between creating it
 * and its own append returning left it behind forever, and every later attempt lost the race to a
 * dead pid's marker and returned duplicate/empty permanently -- exactly the bug the first marker
 * was fixed for, reintroduced one level up.
 *
 * There is now exactly ONE marker file per `(taskId, deliveryId)`, and recovering a stale claim
 * never creates a second one: it removes the stale marker and loops back to the SAME
 * `createMarkerAtomic` exclusivity check a brand-new claim uses. Two concurrent recoverers of the
 * same stale claim race on that one atomic `link`; the filesystem -- not either caller's own
 * bookkeeping -- decides which one wins, exactly like the very first claim ever made for this
 * deliveryId. "Crash during a recovery attempt" and "crash during the original claim" are
 * therefore the identical code path and the identical recoverable shape; there is no
 * recovery-specific state that can get permanently stuck.
 *
 * On EVERY successful claim -- the first attempt ever, or a recovery that just reclaimed a stale
 * one -- the verdict archive (the authoritative record) is re-read and checked BEFORE appending,
 * never after: a dead claimant may have completed its append and died before marking its own
 * marker complete, and the archive is the only source that can tell "never ran" apart from "ran,
 * just didn't get to say so."
 *
 * A claim is only ever removed once proven stale: not completed, no matching archive entry, and
 * its recorded `pid` is not alive. A live claimant's marker is left untouched (reported as a
 * genuine in-flight duplicate) -- this function never races a claimant that might still be
 * writing.
 *
 * FIX ROUND 3 (Dennie, human comment (b), P1): the stale-decision-then-unlink pair above used to
 * have no exclusivity joining them, the identical shape as the `claimReviewSlot` bug this same
 * round fixed in `runCodexReview.js`. Two recoverers can both observe the SAME dead marker; the
 * first fully reclaims it (unlinks the dead marker, creates its own live one, re-checks the
 * archive, and is in flight toward its own append); the second -- still holding only its EARLIER
 * observation of the now-gone dead marker -- reaches its own `unlinkFn(markerPath)` and deletes
 * the first's live replacement, since `unlink(path)` removes whatever currently occupies the
 * path, not specifically the stale generation that was actually observed. Both then proceed to
 * append, producing two archive entries for one delivery -- the exact double-publish the single
 * marker was introduced to prevent, reappearing one level up. The comment this replaced said
 * "the next loop iteration re-reads the true current state rather than assuming" -- true for the
 * NEXT iteration, but it does nothing to undo a removal the CURRENT iteration already committed.
 * The stale branch now re-reads the marker's raw bytes immediately before the destructive unlink
 * and compares them, byte-for-byte, against the raw bytes this observation was originally decided
 * from (never a parsed-field or filesystem-inode comparison -- an inode can be reused by the OS
 * the instant it's freed, which would silently defeat an inode-based check on exactly the kind of
 * fast tmpfs this card's own tests run on). A mismatch, or the marker already gone, means a
 * concurrent recoverer already acted on it, so this caller must never remove it -- it loops back
 * and re-evaluates from scratch instead.
 */
async function publishEntryExactlyOnce({
  tasksDir,
  taskId,
  deliveryId,
  entry,
  readEntriesFn,
  appendEntryFn,
  isPidAliveFn,
  now,
  writeFileFn,
  mkdirFn,
  linkFn,
  renameFn,
  unlinkFn,
  readFileFn
}) {
  const io = { writeFileFn, mkdirFn, linkFn, renameFn, unlinkFn, readFileFn };
  const markerPath = deliveryMarkerPath(tasksDir, taskId, deliveryId);

  for (let attempt = 0; attempt < MAX_CLAIM_RECOVERY_ATTEMPTS; attempt += 1) {
    const claimed = await createMarkerAtomic(markerPath, { pid: process.pid, claimedAt: now() }, io);
    if (claimed) {
      // Authoritative re-check before appending, whether this claim is brand new or just
      // reclaimed a stale one left by a dead process -- see docstring above.
      const existing = await readEntriesFn(tasksDir, taskId);
      const already = existing.find((e) => e.deliveryId === deliveryId);
      if (already) {
        await overwriteMarkerAtomic(markerPath, { completed: true, entry: already }, io).catch(() => {});
        return { alreadyPublished: true, entry: already };
      }
      try {
        await appendEntryFn(tasksDir, taskId, entry);
      } catch (err) {
        await unlinkFn(markerPath).catch(() => {});
        throw err;
      }
      await overwriteMarkerAtomic(markerPath, { completed: true, entry }, io).catch(() => {});
      return { alreadyPublished: false, entry };
    }

    const observedRaw = await readMarkerRaw(markerPath, io);
    if (observedRaw === null) {
      // Raced with someone else's removal of the marker we just failed to create -- the slot is
      // free again; loop back and try to claim it fresh rather than giving up.
      continue;
    }
    let marker;
    try {
      marker = JSON.parse(observedRaw);
    } catch {
      continue; // mid-write or corrupted; re-read fresh rather than trusting a partial parse
    }
    if (marker.completed) {
      return { alreadyPublished: true, entry: marker.entry };
    }

    const existing = await readEntriesFn(tasksDir, taskId);
    const already = existing.find((e) => e.deliveryId === deliveryId);
    if (already) {
      await overwriteMarkerAtomic(markerPath, { completed: true, entry: already }, io).catch(() => {});
      return { alreadyPublished: true, entry: already };
    }

    if (typeof marker.pid === "number" && isPidAliveFn(marker.pid)) {
      // Genuinely concurrent in-flight delivery, not a crash -- defer to it rather than racing
      // its own append.
      return { alreadyPublished: true, entry: null };
    }

    // Stale: not completed, no archive entry, recorded claimant is dead. Re-verify immediately
    // before the destructive act that the marker on disk is still byte-for-byte the SAME content
    // this observation was decided from (see this function's own docstring, FIX ROUND 3). A
    // concurrent recoverer may already have reclaimed this same stale marker and be actively
    // working a brand-new, live one in its place.
    let currentRaw;
    try {
      currentRaw = await readFileFn(markerPath);
    } catch {
      continue; // already gone -- someone else reclaimed or completed it; re-read fresh
    }
    if (currentRaw !== observedRaw) {
      continue; // changed since we looked -- never remove it, re-evaluate from scratch
    }
    await unlinkFn(markerPath).catch(() => {});
  }

  throw new Error(
    `publishCodexVerdict: exceeded ${MAX_CLAIM_RECOVERY_ATTEMPTS} attempts reclaiming the delivery claim for ${taskId}/${deliveryId} -- a live claimant never settled`
  );
}

function processFailureReason(runResult) {
  if (!runResult) return "missing-result";
  if (runResult.kind === "process-failure" || runResult.kind === "parse-failure") {
    return runResult.reason || runResult.kind;
  }
  return "unknown-failure";
}

/**
 * Validates and (exactly once per deliveryId) appends a Codex review verdict for `taskId`.
 *
 * `runResult` is one of:
 *  - `{ kind: "process-failure", reason, detail }` -- non-zero exit, spawn error, timeout, ...
 *  - `{ kind: "parse-failure", reason, detail }` -- truncated/unparseable structured output
 *  - `{ kind: "payload", payload }` -- a structured object the schema still has to validate
 *
 * `dispatchedJob` must carry `jobId`, `ticketId`, `sprintId`, `dispatchedSha`, and
 * `acceptanceCriteriaVersion` -- the frozen contract this specific review was dispatched against.
 * T-0460 FIX ROUND finding (b): a schema-valid, identity-matching payload naming a DIFFERENT
 * (stale) `acceptanceCriteriaVersion` than what was dispatched used to publish as a verdict against
 * the wrong contract for the same commit; it is now part of the identity check below, same as
 * job/ticket/sprint/sha.
 *
 * Returns `{ status, outcome, entry, reason, errors, freshReviewRequested, currentHead }` where
 * `status` is one of "duplicate" | "rejected" | "superseded" | "published".
 */
export async function publishCodexVerdict({
  tasksDir,
  taskId,
  deliveryId,
  dispatchedJob,
  runResult,
  currentHead,
  cancelled = false,
  now = defaultNow,
  readEntriesFn = defaultReadVerdictEntries,
  appendEntryFn = defaultAppendVerdictEntry,
  isPidAliveFn = defaultIsPidAlive,
  writeFileFn = fsp.writeFile,
  mkdirFn = fsp.mkdir,
  linkFn = fsp.link,
  renameFn = fsp.rename,
  unlinkFn = fsp.unlink,
  readFileFn = (p) => fsp.readFile(p, "utf8")
}) {
  if (typeof deliveryId !== "string" || deliveryId.length === 0) {
    throw new Error("publishCodexVerdict requires a non-empty deliveryId");
  }
  if (
    !dispatchedJob ||
    typeof dispatchedJob.jobId !== "string" ||
    typeof dispatchedJob.dispatchedSha !== "string" ||
    typeof dispatchedJob.acceptanceCriteriaVersion !== "string" ||
    dispatchedJob.acceptanceCriteriaVersion.length === 0
  ) {
    throw new Error("publishCodexVerdict requires dispatchedJob.jobId, dispatchedJob.dispatchedSha, and dispatchedJob.acceptanceCriteriaVersion");
  }
  // Required, not merely optional-and-skipped: the whole point of this argument is to let the
  // publisher compare "what was reviewed" against "what the card is at right now." A caller that
  // can't supply it yet has no business asking this function to decide published/superseded.
  if (typeof currentHead !== "string" || currentHead.length === 0) {
    throw new Error("publishCodexVerdict requires currentHead");
  }

  const io = { readEntriesFn, appendEntryFn, isPidAliveFn, now, writeFileFn, mkdirFn, linkFn, renameFn, unlinkFn, readFileFn };

  // A result for a job that was cancelled never publishes, regardless of validity -- cancellation
  // overrides everything else a payload might otherwise have gotten right. Nothing is written, so
  // this never touches the delivery-claim machinery at all.
  if (cancelled) {
    return { status: "rejected", reason: "job-cancelled" };
  }

  const baseEntry = { deliveryId, jobId: dispatchedJob.jobId, ticketId: dispatchedJob.ticketId, sprintId: dispatchedJob.sprintId, dispatchedSha: dispatchedJob.dispatchedSha };

  if (!runResult || runResult.kind !== "payload") {
    const reason = processFailureReason(runResult);
    const entry = {
      ...baseEntry,
      heading: `${HEADING_PREFIX}: BLOCKED`,
      timestamp: now(),
      outcome: "BLOCKED",
      reason,
      text: renderText({ reason, detail: runResult && runResult.detail })
    };
    const published = await publishEntryExactlyOnce({ tasksDir, taskId, deliveryId, entry, ...io });
    if (!published.alreadyPublished) {
      return { status: "published", outcome: "BLOCKED", entry: published.entry, reason };
    }
    return { status: "duplicate", outcome: published.entry ? published.entry.outcome : undefined, entry: published.entry };
  }

  const { payload } = runResult;
  const schemaResult = validateCodexVerdictPayload(payload);
  if (!schemaResult.valid) {
    const entry = {
      ...baseEntry,
      heading: `${HEADING_PREFIX}: BLOCKED`,
      timestamp: now(),
      outcome: "BLOCKED",
      reason: "schema-invalid",
      text: renderText({ reason: "schema-invalid", detail: schemaResult.errors })
    };
    const published = await publishEntryExactlyOnce({ tasksDir, taskId, deliveryId, entry, ...io });
    if (!published.alreadyPublished) {
      return { status: "published", outcome: "BLOCKED", entry: published.entry, reason: "schema-invalid", errors: schemaResult.errors };
    }
    return { status: "duplicate", outcome: published.entry ? published.entry.outcome : undefined, entry: published.entry };
  }

  const identityOk =
    payload.job.jobId === dispatchedJob.jobId &&
    payload.job.ticketId === dispatchedJob.ticketId &&
    payload.job.sprintId === dispatchedJob.sprintId &&
    payload.reviewedSha === dispatchedJob.dispatchedSha &&
    payload.acceptanceCriteriaVersion === dispatchedJob.acceptanceCriteriaVersion;
  if (!identityOk) {
    // Rejected, not published with a correction: nothing is appended to the archive at all, so
    // this never touches the delivery-claim machinery either.
    return { status: "rejected", reason: "identity-mismatch", payload };
  }

  if (currentHead !== dispatchedJob.dispatchedSha) {
    const entry = {
      ...baseEntry,
      heading: `${HEADING_PREFIX}: SUPERSEDED`,
      timestamp: now(),
      outcome: payload.outcome,
      acceptanceCriteriaVersion: payload.acceptanceCriteriaVersion,
      superseded: true,
      currentHead,
      text: renderText({ reason: `head moved to ${currentHead} during review`, payload })
    };
    const published = await publishEntryExactlyOnce({ tasksDir, taskId, deliveryId, entry, ...io });
    if (!published.alreadyPublished) {
      return { status: "superseded", outcome: payload.outcome, entry: published.entry, freshReviewRequested: true, currentHead };
    }
    return { status: "duplicate", outcome: published.entry ? published.entry.outcome : undefined, entry: published.entry };
  }

  const entry = {
    ...baseEntry,
    heading: `${HEADING_PREFIX}: ${payload.outcome}`,
    timestamp: now(),
    outcome: payload.outcome,
    acceptanceCriteriaVersion: payload.acceptanceCriteriaVersion,
    text: renderText({ payload })
  };
  const published = await publishEntryExactlyOnce({ tasksDir, taskId, deliveryId, entry, ...io });
  if (!published.alreadyPublished) {
    return { status: "published", outcome: payload.outcome, entry: published.entry };
  }
  return { status: "duplicate", outcome: published.entry ? published.entry.outcome : undefined, entry: published.entry };
}
