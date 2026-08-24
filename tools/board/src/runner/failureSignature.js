import { createHash } from "node:crypto";

/**
 * Volatile substrings a failure's text can differ on between two attempts that are otherwise the
 * exact same underlying failure -- timestamps, pids, run ids, worktree paths, and durations. Each
 * is replaced with a fixed placeholder before hashing so two genuinely identical failures always
 * normalize to the same text, however their raw output happened to be stamped. Order matters:
 * the worktree-path pattern is greedy over non-whitespace, so it must run before the narrower
 * pid/run-id patterns would otherwise get a chance to partially match inside a path segment.
 */
const TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const WORKTREE_PATH_RE = /\S*\/worktrees\/\S+/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PID_RE = /\bpid[:=]?\s*\d+\b/gi;
const RUN_ID_RE = /\brun[-_ ]?id[:=]?\s*[\w-]+\b/gi;
const DURATION_RE = /\b\d+(?:\.\d+)?\s?(?:ms|milliseconds|s|sec|secs|seconds|m|min|mins|minutes|hr|hrs|hours)\b/gi;
const WHITESPACE_RE = /\s+/g;

/**
 * Strips the volatile parts of a failure's text (timestamps, pids, run ids, worktree paths,
 * durations) so two attempts that failed for the identical, unfixable reason normalize to the
 * same string even though their raw output differs run to run. Never removes the actual error/
 * validation content -- only the bookkeeping noise wrapped around it.
 */
export function normalizeFailureText(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(TIMESTAMP_RE, "<TS>")
    .replace(WORKTREE_PATH_RE, "<WORKTREE_PATH>")
    .replace(UUID_RE, "<UUID>")
    .replace(PID_RE, "pid=<PID>")
    .replace(RUN_ID_RE, "run_id=<RUNID>")
    .replace(DURATION_RE, "<DURATION>")
    .replace(WHITESPACE_RE, " ")
    .trim();
}

/**
 * Computes a stable failure signature (a sha256 hex digest) from the stable parts of one
 * implementer/reviewer attempt's outcome: which phase failed, the verdict, and the normalized
 * error/validation text. Two attempts that failed for the same, unfixable reason hash equal;
 * anything that actually changed between attempts (different phase, different verdict, or
 * genuinely different error text) hashes differently. This is what lets the retry loop
 * (runOrchestrator.js) tell "still the same blocker" apart from "made some progress, still
 * broken a different way" -- see docs' §23-a / HANDOFF.
 */
export function computeFailureSignature({ phase, verdict, notes }) {
  const stable = JSON.stringify({
    phase: phase ?? "unknown",
    verdict: verdict ?? "FAIL",
    notes: normalizeFailureText(notes)
  });
  return createHash("sha256").update(stable).digest("hex");
}
