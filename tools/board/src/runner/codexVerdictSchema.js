/**
 * T-0460: the structured verdict contract a Codex reviewer job must return. Pure validation --
 * no I/O, no clock -- so `codexVerdictPublisher.js` can gate on it deterministically before any
 * verdict reaches the archive. A payload missing a required field (most dangerously `outcome`)
 * fails validation rather than being read as an implicit PASS; see the publisher's BLOCKED path.
 */

export const CODEX_VERDICT_OUTCOMES = ["PASS", "CHANGES_REQUESTED", "BLOCKED"];

const SHA_RE = /^[0-9a-f]{40}$/i;

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function validateCodexVerdictPayload(payload) {
  const errors = [];

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, errors: ["payload must be a JSON object"] };
  }

  const job = payload.job;
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    errors.push("job is required and must be an object with jobId, ticketId, sprintId");
  } else {
    for (const key of ["jobId", "ticketId", "sprintId"]) {
      if (!isNonEmptyString(job[key])) {
        errors.push(`job.${key} must be a non-empty string`);
      }
    }
  }

  if (!isNonEmptyString(payload.reviewedSha) || !SHA_RE.test(payload.reviewedSha)) {
    errors.push("reviewedSha must be a 40-character hex git SHA");
  }

  if (!isNonEmptyString(payload.acceptanceCriteriaVersion)) {
    errors.push("acceptanceCriteriaVersion must be a non-empty string");
  }

  if (!CODEX_VERDICT_OUTCOMES.includes(payload.outcome)) {
    errors.push(`outcome must be one of ${CODEX_VERDICT_OUTCOMES.join(", ")}`);
  }

  if (!Array.isArray(payload.findings)) {
    errors.push("findings must be an array");
  } else {
    payload.findings.forEach((finding, index) => {
      if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
        errors.push(`findings[${index}] must be an object`);
        return;
      }
      if (!isNonEmptyString(finding.file)) {
        errors.push(`findings[${index}].file must be a non-empty string`);
      }
      if (typeof finding.line !== "number" || !Number.isInteger(finding.line)) {
        errors.push(`findings[${index}].line must be an integer`);
      }
      if (!isNonEmptyString(finding.evidence)) {
        errors.push(`findings[${index}].evidence must be a non-empty string`);
      }
    });
  }

  if (!isStringArray(payload.checksPerformed)) {
    errors.push("checksPerformed must be an array of strings");
  }

  if (!isStringArray(payload.limitations)) {
    errors.push("limitations must be an array of strings");
  }

  return { valid: errors.length === 0, errors };
}
