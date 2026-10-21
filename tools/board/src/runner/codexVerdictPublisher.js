import { promises as fsp } from "node:fs";
import path from "node:path";
import { readVerdictEntries as defaultReadVerdictEntries, appendVerdictEntry as defaultAppendVerdictEntry, verdictArchiveDir } from "../lib/verdictArchive.js";
import { validateCodexVerdictPayload } from "./codexVerdictSchema.js";

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

/**
 * The real exactly-once primitive: an exclusive-create ("wx") marker file per (taskId,
 * deliveryId), the same atomic technique launchReservation.js uses for launch slots (fs.link
 * there, fs.open(..., "wx") here -- either way, the OS rejects the second creator, not this
 * process's own bookkeeping). T-0460's own real review run reproduced the race this closes: the
 * pre-fix mechanism was read-existing-entries-then-append with no lock between those two awaits,
 * so two genuinely concurrent deliveries of the same result could both pass the "already
 * recorded?" check before either appended, publishing twice. Whichever caller's open() wins the
 * race proceeds to process and append; the loser is told to treat this delivery as a duplicate.
 */
async function defaultClaimDelivery(tasksDir, taskId, deliveryId) {
  const dir = verdictArchiveDir(tasksDir);
  await fsp.mkdir(dir, { recursive: true });
  const markerPath = path.join(dir, `${taskId}.${deliveryId}.delivered`);
  try {
    const handle = await fsp.open(markerPath, "wx");
    await handle.close();
    return true;
  } catch (err) {
    if (err.code === "EEXIST") {
      return false;
    }
    throw err;
  }
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
  claimDeliveryFn = defaultClaimDelivery
}) {
  if (typeof deliveryId !== "string" || deliveryId.length === 0) {
    throw new Error("publishCodexVerdict requires a non-empty deliveryId");
  }
  if (!dispatchedJob || typeof dispatchedJob.jobId !== "string" || typeof dispatchedJob.dispatchedSha !== "string") {
    throw new Error("publishCodexVerdict requires dispatchedJob.jobId and dispatchedJob.dispatchedSha");
  }
  // Required, not merely optional-and-skipped: the whole point of this argument is to let the
  // publisher compare "what was reviewed" against "what the card is at right now." A caller that
  // can't supply it yet has no business asking this function to decide published/superseded.
  if (typeof currentHead !== "string" || currentHead.length === 0) {
    throw new Error("publishCodexVerdict requires currentHead");
  }

  // Exactly-once, including under real concurrency (not just sequential retries): see
  // defaultClaimDelivery's docstring for the race this closes. Whichever caller fails to claim
  // the marker reads back whatever the winner produced (or finds nothing, if the winner's own
  // append hasn't landed yet / was itself rejected) and reports "duplicate" rather than
  // reprocessing.
  const claimed = await claimDeliveryFn(tasksDir, taskId, deliveryId);
  if (!claimed) {
    const existing = await readEntriesFn(tasksDir, taskId);
    const match = existing.find((entry) => entry.deliveryId === deliveryId);
    return { status: "duplicate", outcome: match ? match.outcome : undefined, entry: match ?? null };
  }

  // A result for a job that was cancelled never publishes, regardless of validity -- cancellation
  // overrides everything else a payload might otherwise have gotten right.
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
    await appendEntryFn(tasksDir, taskId, entry);
    return { status: "published", outcome: "BLOCKED", entry, reason };
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
    await appendEntryFn(tasksDir, taskId, entry);
    return { status: "published", outcome: "BLOCKED", entry, reason: "schema-invalid", errors: schemaResult.errors };
  }

  const identityOk =
    payload.job.jobId === dispatchedJob.jobId &&
    payload.job.ticketId === dispatchedJob.ticketId &&
    payload.job.sprintId === dispatchedJob.sprintId &&
    payload.reviewedSha === dispatchedJob.dispatchedSha;
  if (!identityOk) {
    // Rejected, not published with a correction: nothing is appended to the archive at all.
    return { status: "rejected", reason: "identity-mismatch", payload };
  }

  if (currentHead !== dispatchedJob.dispatchedSha) {
    const entry = {
      ...baseEntry,
      heading: `${HEADING_PREFIX}: SUPERSEDED`,
      timestamp: now(),
      outcome: payload.outcome,
      superseded: true,
      currentHead,
      text: renderText({ reason: `head moved to ${currentHead} during review`, payload })
    };
    await appendEntryFn(tasksDir, taskId, entry);
    return { status: "superseded", outcome: payload.outcome, entry, freshReviewRequested: true, currentHead };
  }

  const entry = {
    ...baseEntry,
    heading: `${HEADING_PREFIX}: ${payload.outcome}`,
    timestamp: now(),
    outcome: payload.outcome,
    text: renderText({ payload })
  };
  await appendEntryFn(tasksDir, taskId, entry);
  return { status: "published", outcome: payload.outcome, entry };
}
