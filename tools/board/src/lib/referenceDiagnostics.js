/**
 * Diagnostic response-header surfacing for reference-fetch rejections (T-0283).
 *
 * `referenceTransport.js` already captures every response header, but until now
 * `referenceSourcing.js`'s rejection paths threw away everything except the status code, which
 * made a 429 undiagnosable from a run log -- five separate T-0273 sessions hit the same
 * `wikimedia ... failed with status 429` wall with nothing to route-diagnose it from. This module
 * is deliberately an **allowlist**, not a denylist: only the header names below are ever echoed
 * back into an error message, so a header that identifies a credential (`Authorization`,
 * `Cookie`, `Set-Cookie`) can never leak into a printed/logged error even if a misbehaving
 * upstream sent one on a rejection response -- there is no code path that could accidentally add
 * a new sensitive header to what gets logged, the way there would be with a denylist.
 */

const DIAGNOSTIC_HEADER_NAMES = Object.freeze(["retry-after", "via", "x-cache", "server", "cf-ray", "x-served-by", "x-forwarded-for"]);

function isDiagnosticHeaderName(name) {
  return DIAGNOSTIC_HEADER_NAMES.includes(name) || name.startsWith("x-ratelimit-");
}

/**
 * @param {object} [headers] a response headers object (Node lowercases header names already)
 * @returns {Object<string, string>} only the allowlisted diagnostic headers present in `headers`
 */
export function extractDiagnosticHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== "object") return out;
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (!isDiagnosticHeaderName(name)) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

/**
 * @param {object} [headers]
 * @returns {string} `"name=value, name=value"` for every allowlisted header present, or `""`
 */
export function formatDiagnosticHeaders(headers) {
  return Object.entries(extractDiagnosticHeaders(headers))
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");
}
