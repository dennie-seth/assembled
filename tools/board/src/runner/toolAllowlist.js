import fs from "node:fs";
import path from "node:path";
import { splitFrontmatter } from "./frontmatter.js";

/** Safe default for `agent: null` (or any agent def that can't be resolved): read-only, no Bash. */
export const READ_ONLY_DEFAULT_TOOLS = Object.freeze(["Read", "Grep", "Glob"]);

export function parseToolsString(toolsStr) {
  if (typeof toolsStr !== "string") {
    return [];
  }
  return toolsStr
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Resolves the `--allowedTools` list for a card from its `agent:` field via
 * the matching `.claude/agents/<agent>.md` frontmatter `tools:` string.
 * Anything that can't be resolved (agent: null, unknown agent, unreadable
 * or malformed agent file) falls back to READ_ONLY_DEFAULT_TOOLS rather
 * than throwing — an unresolvable agent must never mean "no restrictions".
 */
export function resolveAllowedTools(
  agentName,
  { agentsDir = ".claude/agents", readFileFn = fs.readFileSync } = {}
) {
  if (!agentName) {
    return [...READ_ONLY_DEFAULT_TOOLS];
  }

  let raw;
  try {
    raw = readFileFn(path.join(agentsDir, `${agentName}.md`), "utf8");
  } catch {
    return [...READ_ONLY_DEFAULT_TOOLS];
  }

  let data;
  try {
    ({ data } = splitFrontmatter(raw));
  } catch {
    return [...READ_ONLY_DEFAULT_TOOLS];
  }

  if (typeof data.tools !== "string") {
    return [...READ_ONLY_DEFAULT_TOOLS];
  }

  return parseToolsString(data.tools);
}

function parseToolPattern(pattern) {
  const match = /^([A-Za-z][\w-]*)(?:\(([^)]*)\))?$/.exec(String(pattern).trim());
  if (!match) {
    return null;
  }
  return { tool: match[1], arg: match[2] ?? null };
}

/** The only tools whose argument is a filesystem path rather than a command string. */
const PATH_ARG_TOOLS = new Set(["Edit", "Write"]);

/**
 * Whether `requestedPath` resolves to somewhere under a `.claude/` directory, after collapsing
 * `./` and `..` segments -- an absolute path inside any worktree, a leading `./`, and traversal
 * (`tools/../.claude/settings.json`) all normalize to have `.claude` as an exact path segment. A
 * path that merely contains the text `.claude` elsewhere (`docs/notes-on-.claude.md`) normalizes
 * to a segment that is not an exact match, so it is left alone.
 */
function isUnderClaudeDir(requestedPath) {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    return false;
  }
  return path
    .normalize(requestedPath)
    .split(path.sep)
    .filter(Boolean)
    .includes(".claude");
}

/**
 * Why a `.claude/` Edit/Write is denied regardless of grant: the Claude Code CLI's own
 * sensitive-file protection blocks it outright in an unattended run (T-0374 tried seven
 * mechanisms live; all denied with `decision_reason_type: safetyCheck`). The board's allowlist
 * model has to agree, or anything that reasons from it is wrong about `.claude/`.
 */
export const CLAUDE_DIR_DENIAL_REASON =
  "Denied: the Claude Code CLI's built-in sensitive-file protection blocks every Edit/Write " +
  "under .claude/ in an unattended run, regardless of the agent's tool grant.";

/**
 * Whether a requested tool call (e.g. "Bash(git:status)") is covered by a resolved allowlist
 * (e.g. ["Read", "Bash(git:*)"]), plus -- for Edit/Write -- why it was denied when the target
 * path resolves under .claude/. This is the single source of truth `isToolAllowed` delegates to.
 *
 * @returns {{allowed: boolean, reason: string|null}}
 */
export function checkToolPermission(requestedTool, allowedTools) {
  const requested = parseToolPattern(requestedTool);
  if (!requested) {
    return { allowed: false, reason: null };
  }

  if (PATH_ARG_TOOLS.has(requested.tool) && requested.arg !== null && isUnderClaudeDir(requested.arg)) {
    return { allowed: false, reason: CLAUDE_DIR_DENIAL_REASON };
  }

  const allowed = allowedTools.some((pattern) => {
    const allowedPattern = parseToolPattern(pattern);
    if (!allowedPattern || allowedPattern.tool !== requested.tool) {
      return false;
    }
    if (allowedPattern.arg === null) {
      return true;
    }
    if (requested.arg === null) {
      return false;
    }
    // `cmd:*` and a bare `cmd*` both mean "prefix wildcard" -- strip only the trailing `*`.
    // A bare trailing `*` (no colon) is required for prefixes that end by gluing a value
    // directly on with no word boundary, e.g. inline env-var assignment (`DATABASE_URL=*`):
    // the live Claude Code CLI does not honor `:*` for that shape (verified v2.1.78).
    if (allowedPattern.arg.endsWith("*")) {
      return requested.arg.startsWith(allowedPattern.arg.slice(0, -1));
    }
    return requested.arg === allowedPattern.arg;
  });

  return { allowed, reason: null };
}

/**
 * Whether a requested tool call (e.g. "Bash(git:status)") is covered by a
 * resolved allowlist (e.g. ["Read", "Bash(git:*)"]). Everything not
 * explicitly matched is denied.
 */
export function isToolAllowed(requestedTool, allowedTools) {
  return checkToolPermission(requestedTool, allowedTools).allowed;
}
