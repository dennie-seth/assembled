import { readVerdictEntries as defaultReadVerdictEntries, appendVerdictEntry as defaultAppendVerdictEntry } from "../lib/verdictArchive.js";
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
  appendEntryFn = defaultAppendVerdictEntry
}) {
  if (typeof deliveryId !== "string" || deliveryId.length === 0) {
    throw new Error("publishCodexVerdict requires a non-empty deliveryId");
  }
  if (!dispatchedJob || typeof dispatchedJob.jobId !== "string" || typeof dispatchedJob.dispatchedSha !== "string") {
    throw new Error("publishCodexVerdict requires dispatchedJob.jobId and dispatchedJob.dispatchedSha");
  }

  // Exactly-once: a retry, a restart, or a replayed delivery of the same result is a pure no-op
  // once its deliveryId has already been recorded -- this read-before-append check, keyed on
  // the archive itself rather than any in-memory state, is the mechanism (not "timing").
  const existing = await readEntriesFn(tasksDir, taskId);
  const duplicate = existing.find((entry) => entry.deliveryId === deliveryId);
  if (duplicate) {
    return { status: "duplicate", outcome: duplicate.outcome, entry: duplicate };
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
    payload.reviewedSha === dispatchedJob.dispatchedSha;
  if (!identityOk) {
    // Rejected, not published with a correction: nothing is appended to the archive at all.
    return { status: "rejected", reason: "identity-mismatch", payload };
  }

  if (typeof currentHead === "string" && currentHead.length > 0 && currentHead !== dispatchedJob.dispatchedSha) {
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
