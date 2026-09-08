const FENCE_LANG = "host-action-request";
const FENCE_RE = /```host-action-request\n([\s\S]*?)```/;

/**
 * The four fields every host-action request must carry (T-0323). Order matters only for
 * rendering -- `parseHostActionRequest` requires all four, in any order, or returns null.
 */
export const HOST_ACTION_REQUEST_FIELDS = ["host", "action", "reason", "verify"];

/**
 * Renders a host-action request as a fenced, machine-parseable block -- the structured
 * alternative to prose in a blocker report. Motivated by T-0272/T-0317: round 9 of that incident
 * named the exact host fix in English, and nothing downstream could act on it as anything other
 * than a paragraph a human had to re-read four rounds in. See docs/design/host-action-escalation.md.
 */
export function formatHostActionRequest({ host, action, reason, verify }) {
  const values = { host, action, reason, verify };
  const lines = HOST_ACTION_REQUEST_FIELDS.map((key) => `${key}: ${values[key]}`);
  return ["```" + FENCE_LANG, ...lines, "```"].join("\n");
}

/**
 * Extracts a host-action request from free text (e.g. reviewer FAIL notes), or null if no
 * well-formed block is present. All four fields are required -- a partial block is not
 * actionable, and treating it as one would let an incomplete diagnosis masquerade as a genuine,
 * structured handoff.
 */
export function parseHostActionRequest(text) {
  if (typeof text !== "string") return null;
  const match = FENCE_RE.exec(text);
  if (!match) return null;

  const fields = {};
  for (const line of match[1].split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (HOST_ACTION_REQUEST_FIELDS.includes(key) && value.length > 0) {
      fields[key] = value;
    }
  }

  const complete = HOST_ACTION_REQUEST_FIELDS.every((key) => typeof fields[key] === "string");
  return complete ? fields : null;
}
