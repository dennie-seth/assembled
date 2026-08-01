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

/**
 * Whether a requested tool call (e.g. "Bash(git:status)") is covered by a
 * resolved allowlist (e.g. ["Read", "Bash(git:*)"]). Everything not
 * explicitly matched is denied.
 */
export function isToolAllowed(requestedTool, allowedTools) {
  const requested = parseToolPattern(requestedTool);
  if (!requested) {
    return false;
  }
  return allowedTools.some((pattern) => {
    const allowed = parseToolPattern(pattern);
    if (!allowed || allowed.tool !== requested.tool) {
      return false;
    }
    if (allowed.arg === null) {
      return true;
    }
    if (requested.arg === null) {
      return false;
    }
    if (allowed.arg.endsWith(":*")) {
      return requested.arg.startsWith(allowed.arg.slice(0, -1));
    }
    return requested.arg === allowed.arg;
  });
}
