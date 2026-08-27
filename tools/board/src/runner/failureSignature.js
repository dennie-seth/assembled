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
 * Computes a stable failure signature (a sha256 hex digest) for one implementer/reviewer
 * attempt, from **what the attempt actually left behind**: the worktree's git state, plus
 * which phase failed and the verdict category.
 *
 * The reviewer's free-text notes are deliberately NOT part of the basis. They used to be, and
 * that is exactly why the abort never fired on T-0229: the card burned all five retry slots on
 * eight consecutive FAILs whose branch state the reviewer itself called "byte-identical to runs
 * 2-7", because each note opens with an incrementing ordinal ("Third consecutive FAIL", ...
 * "Eighth consecutive FAIL"). Every attempt hashed differently by construction, no matter how
 * thoroughly the text was normalized -- a counter is not volatile noise a regex can strip, it is
 * the reviewer legitimately describing a different attempt number. Prose is the wrong thing to
 * hash; the tree is the right one.
 *
 * `state` is `{ head, tree, dirty }` from gitOps.readTreeState: the HEAD commit, its tree object,
 * and the porcelain status. Two attempts that leave byte-identical tracked state produce the same
 * signature by definition, which is the whole claim "no progress" is making. An attempt that
 * committed anything, or even left a new uncommitted file, moves at least one of the three.
 *
 * Returns **null** when `state` is absent (git state unreadable). A null signature is never
 * compared, so the loop degrades to running the full retry cap rather than risking a false abort
 * on a card that might genuinely be progressing.
 */
export function computeFailureSignature({ phase, verdict, state }) {
  if (!state || typeof state !== "object") return null;
  const stable = JSON.stringify({
    phase: phase ?? "unknown",
    verdict: verdict ?? "FAIL",
    head: state.head ?? "",
    tree: state.tree ?? "",
    dirty: normalizeFailureText(state.dirty)
  });
  return createHash("sha256").update(stable).digest("hex");
}
