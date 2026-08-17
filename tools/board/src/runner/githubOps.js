import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function gh(args, cwd) {
  return execFileAsync("gh", args, { cwd });
}

function errorText(err) {
  return `${err?.stderr ?? ""}\n${err?.message ?? ""}`;
}

// Matched first: an "already exists" response means a PR is already open for this branch --
// idempotent success, not a failure, and never worth retrying.
const ALREADY_EXISTS_RE = /pull request already exists/i;

// GitHub-side blips worth retrying: 5xx responses (the 2026-08-17 GraphQL outage that motivated
// this file was a bare "HTTP 503 ... api.github.com/graphql"), "no server currently available"
// (the GraphQL backend's own wording for the same kind of outage), and secondary/abuse rate
// limiting (which resolves on its own after a short wait). Deliberately does NOT match on a bare
// "403" -- that's also used for plain permission-denied responses, which are terminal.
const TRANSIENT_RE =
  /\bHTTP\s*(500|502|503|504)\b|(?:^|\D)(500|502|503|504)(?:\D|$)|no server is currently available|secondary rate limit|abuse detection|rate limit exceeded/i;

/**
 * Classifies a `gh` CLI failure so the caller can decide whether to retry:
 * - "already-exists": a PR for this branch is already open -- treat as success, look it up.
 * - "transient": a GitHub-side blip (5xx, GraphQL outage, rate limiting) -- worth retrying,
 *   or falling back from GraphQL (`gh pr create`) to the REST API if it keeps failing.
 * - "terminal": auth or validation failure -- retrying (or falling back to REST, which uses
 *   the same credentials) would just fail the same way again.
 */
export function classifyGhError(err) {
  const text = typeof err === "string" ? err : errorText(err);
  if (ALREADY_EXISTS_RE.test(text)) return "already-exists";
  if (TRANSIENT_RE.test(text)) return "transient";
  return "terminal";
}

function ghError(err) {
  const wrapped = err instanceof Error ? err : new Error(errorText(err));
  wrapped.ghClassification = classifyGhError(err);
  return wrapped;
}

/**
 * Whether the `gh` CLI can open a PR right now: installed AND authenticated.
 * Distinguishes the two so the caller can log an actionable, specific reason.
 */
export async function checkAvailability({ worktreeDir }) {
  try {
    await gh(["--version"], worktreeDir);
  } catch {
    return { available: false, reason: "not-installed" };
  }
  try {
    await gh(["auth", "status"], worktreeDir);
  } catch {
    return { available: false, reason: "not-authenticated" };
  }
  return { available: true, reason: null };
}

/**
 * URL of an already-open PR for `branch`, or null if none exists. `gh pr view` goes through
 * GraphQL: if it fails transiently (GraphQL down, per the 2026-08-17 incident) that's not proof
 * no PR exists, so this falls back to the REST listing instead of reporting a false negative.
 * A genuine "not found" (or any other terminal failure) still just returns null, unchanged from
 * before.
 */
export async function findExistingPr({ worktreeDir, branch }) {
  try {
    const { stdout } = await gh(["pr", "view", branch, "--json", "url"], worktreeDir);
    const data = JSON.parse(stdout);
    return typeof data.url === "string" ? data.url : null;
  } catch (err) {
    if (classifyGhError(err) === "transient") {
      return findExistingPrRest({ worktreeDir, branch });
    }
    return null;
  }
}

/** REST-API equivalent of findExistingPr, used when GraphQL (`gh pr view`) is unavailable. */
export async function findExistingPrRest({ worktreeDir, branch }) {
  try {
    const { stdout } = await gh(["api", "repos/{owner}/{repo}/pulls", "-f", "state=open"], worktreeDir);
    const prs = JSON.parse(stdout);
    const match = Array.isArray(prs) ? prs.find((pr) => pr?.head?.ref === branch) : null;
    return match?.html_url ?? null;
  } catch {
    return null;
  }
}

/**
 * Opens a PR for `head` -> `base` via `gh pr create` (GraphQL) and returns its URL. A single
 * attempt -- no retry here, since retry policy (how many attempts, backoff, when to fall back to
 * REST) is the orchestrator's call, not this transport-level function's. Failures are thrown
 * with `.ghClassification` attached (see classifyGhError) so the caller can decide what to do.
 */
export async function createPr({ worktreeDir, base, head, title, body }) {
  try {
    const { stdout } = await gh(
      ["pr", "create", "--base", base, "--head", head, "--title", title, "--body", body],
      worktreeDir
    );
    const match = stdout.match(/https:\/\/\S+/);
    return match ? match[0] : stdout.trim();
  } catch (err) {
    throw ghError(err);
  }
}

/**
 * REST-API fallback for createPr, used when `gh pr create` (GraphQL) keeps failing transiently.
 * REST stayed available during the 2026-08-17 GraphQL-only outage that motivated this. Uses gh's
 * `{owner}/{repo}` placeholder expansion (resolved from the worktree's own git remote) rather
 * than a separate lookup call. Same single-attempt, classified-error contract as createPr.
 */
export async function createPrRest({ worktreeDir, base, head, title, body }) {
  try {
    const { stdout } = await gh(
      [
        "api",
        "--method",
        "POST",
        "repos/{owner}/{repo}/pulls",
        "-f",
        `title=${title}`,
        "-f",
        `head=${head}`,
        "-f",
        `base=${base}`,
        "-f",
        `body=${body}`
      ],
      worktreeDir
    );
    const data = JSON.parse(stdout);
    return data.html_url;
  } catch (err) {
    throw ghError(err);
  }
}
