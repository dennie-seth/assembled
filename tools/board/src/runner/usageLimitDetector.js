/**
 * Matches an explicit rate-limit/session-limit *error code* the CLI puts on a refused turn
 * (`event.error`) -- a short, enum-ish field, never narrative prose. This is deliberately the
 * only place free text is still matched: see `usageLimitSignatureForEvent`'s docstring for why
 * prose in assistant/tool/result output is never trusted on its own.
 */
const USAGE_LIMIT_ERROR_CODE_RE =
  /usage limit|session limit|rate.?limit(?:ed|ing)?|quota exceeded|exceeded[^.\n]{0,30}quota|too many requests|\b429\b|weekly limit|out of (?:usage|credits)|limit will reset/i;

/** True if `text` contains a usage/rate-limit signature. */
export function containsUsageLimitSignature(text) {
  return typeof text === "string" && USAGE_LIMIT_ERROR_CODE_RE.test(text);
}

/**
 * A `rate_limit_event`'s `rate_limit_info` is structured telemetry, present on healthy sessions
 * as well as refused ones. Only the top-level `status` says whether *this* request was refused:
 * "allowed" and "allowed_warning" are healthy. Sibling fields like `overageStatus: "rejected"`
 * and `overageDisabledReason: "out_of_credits"` describe whether overage *would* be available
 * and ride along on healthy events too, so they must not be read as a refusal.
 */
export function rateLimitInfoRejects(info) {
  return Boolean(info) && typeof info === "object" && info.status === "rejected";
}

/**
 * The `rate_limit_info` payload of a `rate_limit_event`, or `null` for any other event shape.
 * Shared with `usageWindow.js`, which reads the same telemetry for a utilization reading rather
 * than a refusal verdict -- one place that knows where this payload lives, two questions asked
 * of it.
 */
export function rateLimitInfoFromEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  if (event.type !== "rate_limit_event") return null;
  const info = event.rate_limit_info;
  return info && typeof info === "object" && !Array.isArray(info) ? info : null;
}

/**
 * True if a `result` event is the CLI's own terminal refusal of a request. This is a structural
 * check on `is_error`/`terminal_reason`/`api_error_status` -- never a text match against the
 * event's own `result` string, which merely narrates the refusal and would otherwise let a
 * healthy `terminal_reason: "completed"` result masquerade as a stop just because it discusses
 * one (see T-0367/PR #381).
 */
function resultEventIsApiErrorRejection(event) {
  return (
    event.type === "result" &&
    event.is_error === true &&
    event.terminal_reason === "api_error" &&
    event.api_error_status === 429
  );
}

/**
 * Names the structured signal that proves `event` is a genuine usage/rate-limit stop, or `null`
 * if it carries none. Returning the signal's *name*, not just a boolean, is what lets the
 * escalation-skip log line say which one fired (T-0377 acceptance: a future false positive must
 * be diagnosable from the log alone).
 *
 * T-0367/PR #381: a run whose docs, test fixtures and reviewer notes quoted the T-0366 refusal
 * line "You've hit your session limit" 39 times -- on a run whose six `result` events all ended
 * `terminal_reason: "completed"` with no `api_error_status`, and whose `rate_limit_event`
 * telemetry all reported `status: "allowed"` -- had its three genuine reviewer FAILs swallowed as
 * a quota pause, because the old implementation matched that quoted prose. Only structured
 * signals count now: `rate_limit_info.status === "rejected"`, a terminal `result` event whose own
 * `is_error`/`terminal_reason`/`api_error_status` fields prove a refused request, or an explicit
 * `error` code on the event. Free text in assistant turns, tool output, or reviewer verdict prose
 * never counts on its own, no matter which of these phrases it quotes.
 */
export function usageLimitSignatureForEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;

  if (rateLimitInfoRejects(event.rate_limit_info)) return "rate_limit_info.status=rejected";

  if (resultEventIsApiErrorRejection(event)) {
    return `result.is_error=true,terminal_reason=api_error,api_error_status=${event.api_error_status}`;
  }

  if (containsUsageLimitSignature(event.error)) return `error=${event.error}`;

  return null;
}

/** True if a single parsed NDJSON event indicates a genuine usage/rate-limit stop. */
export function eventIndicatesUsageLimit(event) {
  return usageLimitSignatureForEvent(event) !== null;
}

/**
 * Scans a run's parsed NDJSON events (implementer and/or reviewer, across one or more attempts)
 * for a genuine usage/rate-limit stop, returning the name of the first structured signal found,
 * or `null` if none did. Deliberately biased toward `null`: a card whose retries were exhausted
 * for real reasons must still escalate, even if its own output happens to quote a rate-limit
 * phrase (in a fixture, a doc, a reviewer's notes, or the CLI's own prose on an otherwise-healthy
 * completed turn).
 */
export function usageLimitSignatureForEvents(events) {
  if (!Array.isArray(events)) return null;
  for (const event of events) {
    const signature = usageLimitSignatureForEvent(event);
    if (signature) return signature;
  }
  return null;
}

/**
 * Scans a run's parsed NDJSON events for a genuine usage/rate-limit stop. This predicate gates
 * escalation suppression, so it is deliberately biased toward *false*: see
 * `usageLimitSignatureForEvents` for the full rationale and the structured signals that count.
 */
export function eventsContainUsageLimitSignature(events) {
  return usageLimitSignatureForEvents(events) !== null;
}
