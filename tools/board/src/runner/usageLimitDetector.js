/**
 * Matches text signatures a real `claude` CLI run leaves behind when it hits an Anthropic
 * token/usage/weekly/rate limit -- a transient environmental stop, not a genuine blocker (see
 * docs/design/escalation-workflow.md). Deliberately does not match a bare "limit" so ordinary
 * text (a style-guide "character limit", a numeric cap in a spec) doesn't false-positive.
 */
const USAGE_LIMIT_RE =
  /usage limit|session limit|rate.?limit(?:ed|ing)?|quota exceeded|exceeded[^.\n]{0,30}quota|too many requests|\b429\b|weekly limit|out of (?:usage|credits)|limit will reset/i;

/** True if `text` contains a usage/rate-limit signature. */
export function containsUsageLimitSignature(text) {
  return typeof text === "string" && USAGE_LIMIT_RE.test(text);
}

/**
 * Fields that carry human-readable prose, and are therefore the only ones worth text-matching.
 *
 * An earlier version scanned `JSON.stringify(event)` instead, on the reasoning that the exact
 * field a real CLI surfaces a limit on wasn't pinned down. Live run logs have since pinned it
 * down, and that reasoning turned out to be actively harmful: the CLI emits a
 * `{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":...}}` telemetry event on
 * *every* session, healthy ones included, so the serialized form always contained "rate_limit"
 * and the detector returned true for every run. Since this predicate *suppresses* escalation,
 * that silently disabled blocker reports and remediation cards board-wide (found on T-0233).
 *
 * Keys are excluded on purpose: `type`/`subtype` are enum discriminators, and `uuid`/`session_id`
 * are opaque identifiers. None of them are prose, and all of them can contain a marker verbatim.
 */
function proseFrom(event) {
  const parts = [];
  if (typeof event.result === "string") parts.push(event.result);
  if (typeof event.message === "string") parts.push(event.message);
  const content = event.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n");
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

/** True if a single parsed NDJSON event indicates a genuine usage/rate-limit stop. */
export function eventIndicatesUsageLimit(event) {
  if (typeof event === "string") return containsUsageLimitSignature(event);
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;

  // Structured telemetry is authoritative for its own event: judge it by status, never by
  // substring. Fall through rather than returning early, since a refusal can also be narrated
  // in a sibling prose field on the same event.
  if (rateLimitInfoRejects(event.rate_limit_info)) return true;

  // The CLI tags the refusal turn with an explicit error code; its prose ("You've hit your
  // session limit") is matched by USAGE_LIMIT_RE independently, but the code is the reliable half.
  if (containsUsageLimitSignature(event.error)) return true;

  return containsUsageLimitSignature(proseFrom(event));
}

/**
 * Scans a run's parsed NDJSON events (implementer and/or reviewer, across one or more attempts)
 * for a genuine usage/rate-limit stop.
 *
 * This predicate gates escalation suppression, so it is deliberately biased toward *false*: a
 * card whose retries were exhausted for real reasons must still escalate. Only an explicit
 * rejection -- `rate_limit_info.status === "rejected"`, a `rate_limit` error code, or matching
 * prose -- counts.
 */
export function eventsContainUsageLimitSignature(events) {
  if (!Array.isArray(events)) return false;
  return events.some((event) => eventIndicatesUsageLimit(event));
}
