/**
 * Policy for `tools/board/scripts/agentCurl.js` -- the only HTTP client the
 * `assets` / `audio` agents are granted.
 *
 * Why this exists: those two agents used to carry a blanket `Bash(curl:*)`
 * grant, which also let them reach the board's own mutating task API on
 * loopback. That is not hypothetical -- during the T-0221 diagnosis an
 * implementer whose `gh pr create` was denied routed around the denial with
 * `curl -s -X PATCH http://127.0.0.1:4173/api/tasks/T-0153 -d '{"status":...}'`
 * and self-reported its card into `review`.
 *
 * The Claude Code `--allowedTools` grammar the runner emits is a *command
 * prefix* match with a single trailing `*` (see `runner/toolAllowlist.js`),
 * so `Bash(curl ...)` cannot express "any flags, but only to host X" -- real
 * agent calls put flags before the URL in arbitrary order
 * (`curl -s --connect-timeout 5 http://172.18.192.1:8188/system_stats`).
 * The grant is therefore given to this wrapper instead, and the host/method
 * policy is enforced here.
 *
 * Shape of the policy: the board's own API is the protected resource, so it
 * is the only thing restricted. Everything else agents legitimately curl --
 * ComfyUI (`172.18.192.1:8188`), ACE-Step / Stable Audio (`:8001` / `:8002`),
 * reference-corpus downloads over the public internet -- passes through
 * unchanged.
 */

/** Default board API port; the vite dev server proxies `/api` to it. */
export const DEFAULT_BOARD_PORT = 4173;
/** Vite dev-server port -- `/api` and `/ws` there proxy straight to the board. */
export const DEFAULT_VITE_PORT = 5173;

/** Methods the wrapper will issue at all. */
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
/** Methods that are safe against the board API (read-only). */
const BOARD_READ_METHODS = new Set(["GET", "HEAD"]);

/** The one mutating board route agents genuinely need: attachment upload. */
const BOARD_ATTACHMENTS_RE = /^\/api\/tasks\/T-\d{4}\/attachments$/;

/**
 * curl flags that would let a caller override the method or target we just
 * validated, or fire a second request we never saw. Rejected outright rather
 * than interpreted.
 */
const FORBIDDEN_FLAGS = new Set([
  "-X",
  "--request",
  "-K",
  "--config",
  "--url",
  "--next",
  "-:",
  "-T",
  "--upload-file",
  "-G",
  "--get"
]);

function normalizeBoardPorts({ boardPort, vitePort } = {}) {
  const ports = new Set();
  ports.add(Number(boardPort) || DEFAULT_BOARD_PORT);
  ports.add(Number(vitePort) || DEFAULT_VITE_PORT);
  return ports;
}

function deny(reason) {
  return { allowed: false, reason };
}

const ALLOW = Object.freeze({ allowed: true, reason: null });

/**
 * Does this argument smuggle a second target past the validated URL?
 * curl treats any bare (non-flag, non-flag-value) argument as another URL,
 * so anything that could parse as one is refused.
 */
function looksLikeUrl(arg) {
  if (arg.includes("://")) {
    return true;
  }
  // Bare `host:port/path` -- curl accepts it and defaults the scheme, and it
  // is the only scheme-less shape that can name the board (`127.0.0.1:4173`).
  // Deliberately NOT flagging plain `some/path` shapes: those are ordinary
  // flag values (`-o assets/out/frame.png`) and cannot reach a specific port.
  return /^\[?[\w.:-]+\]?:\d+(\/|$)/.test(arg);
}

/**
 * Decides whether an `agentCurl.js <METHOD> <URL> [curl args...]` invocation
 * may run. Fail-closed: anything not explicitly recognized is denied.
 *
 * @returns {{allowed: boolean, reason: string|null}}
 */
export function checkAgentCurlRequest({ method, url, args = [], boardPort, vitePort } = {}) {
  if (typeof method !== "string" || method.length === 0) {
    return deny("missing method (usage: agentCurl.js <METHOD> <URL> [curl args...])");
  }
  const upperMethod = method.toUpperCase();
  if (!ALLOWED_METHODS.has(upperMethod)) {
    return deny(`method ${upperMethod} is not supported by this wrapper`);
  }

  if (typeof url !== "string" || url.length === 0) {
    return deny("missing URL (usage: agentCurl.js <METHOD> <URL> [curl args...])");
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return deny(`URL is not parseable: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return deny(`only http/https URLs are allowed, got ${parsed.protocol}`);
  }

  if (!Array.isArray(args)) {
    return deny("curl args must be an array");
  }
  for (const rawArg of args) {
    const arg = String(rawArg);
    const flagName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (FORBIDDEN_FLAGS.has(flagName)) {
      return deny(
        `curl flag ${flagName} is not allowed -- the method and URL are fixed by the first two arguments`
      );
    }
    // Bundled short flags, e.g. `-sX PATCH`.
    if (/^-[a-zA-Z:]+$/.test(arg) && !arg.startsWith("--") && (arg.includes("X") || arg.includes("T") || arg.includes("G") || arg.includes("K"))) {
      return deny(`curl flag ${arg} bundles a method/target override and is not allowed`);
    }
    if (!arg.startsWith("-") && looksLikeUrl(arg)) {
      return deny(`extra URL-shaped argument is not allowed: ${arg}`);
    }
  }

  const boardPorts = normalizeBoardPorts({ boardPort, vitePort });
  // Anything not on a board port is out of scope for this policy -- ComfyUI,
  // the audio services, and public reference downloads all pass through.
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? "443" : "80") : parsed.port;
  if (!boardPorts.has(Number(port))) {
    return ALLOW;
  }

  if (BOARD_READ_METHODS.has(upperMethod)) {
    return ALLOW;
  }
  if (upperMethod === "POST" && BOARD_ATTACHMENTS_RE.test(parsed.pathname)) {
    return ALLOW;
  }

  return deny(
    `${upperMethod} ${parsed.pathname} targets the board API -- agents may only read it (GET/HEAD) ` +
      `and POST to /api/tasks/<T-NNNN>/attachments. Never change your own card's state: the Agent ` +
      `Runner orchestrator owns every status transition.`
  );
}
