/**
 * Matches text signatures a real `claude` CLI run leaves behind when it hits an Anthropic
 * token/usage/weekly/rate limit -- a transient environmental stop, not a genuine blocker (see
 * docs/design/escalation-workflow.md). Deliberately does not match a bare "limit" so ordinary
 * text (a style-guide "character limit", a numeric cap in a spec) doesn't false-positive.
 */
const USAGE_LIMIT_RE =
  /usage limit|rate.?limit(?:ed|ing)?|quota exceeded|exceeded[^.\n]{0,30}quota|too many requests|\b429\b|weekly limit|out of (?:usage|credits)|limit will reset/i;

/** True if `text` contains a usage/rate-limit signature. */
export function containsUsageLimitSignature(text) {
  return typeof text === "string" && USAGE_LIMIT_RE.test(text);
}

/**
 * Scans a run's parsed NDJSON events (implementer and/or reviewer, across one or more attempts)
 * for a usage/rate-limit signature anywhere in the payload -- assistant text, a result event's
 * `result` field, a system/error event's message, etc. Serializes each event once rather than
 * hand-picking fields, since the exact field a real CLI surfaces this on isn't pinned down by
 * any confirmed live behavior yet (see docs/design/escalation-workflow.md's judgment-call note).
 */
export function eventsContainUsageLimitSignature(events) {
  if (!Array.isArray(events)) return false;
  return events.some((event) => containsUsageLimitSignature(JSON.stringify(event)));
}
