import { isToolAllowed } from "./toolAllowlist.js";

/**
 * The two files that govern every agent's own permissions. See
 * docs/design/claude-cli-sensitive-file-protection.md -- these must never be coverable by any
 * agent's resolved --allowedTools, since an agent that can edit its own permission config can
 * grant itself anything.
 */
export const SENSITIVE_SETTINGS_FILES = Object.freeze([".claude/settings.json", ".claude/settings.local.json"]);

/**
 * Candidate grant for "an agent may Edit/Write .claude/agents, .claude/rules, .claude/skills" --
 * NOT wired into any real `.claude/agents/*.md` file today. T-0374 verified live (v2.1.241,
 * 2026-09-12, see docs/design/claude-cli-sensitive-file-protection.md) that the Claude Code CLI's
 * built-in sensitive-file safety check denies any Edit/Write under `.claude/` in a headless (-p)
 * run regardless of what --allowedTools contains -- this exact pattern set was tested and still
 * denied. It is kept only so its exclusion of the settings files (below) is unit-tested and
 * correct, ready for the day a real override exists. Deliberately names each directory instead of
 * a bare `.claude/**` or `.claude/*` so it can never structurally match `.claude/settings.json` /
 * `.claude/settings.local.json`, in addition to those staying denied at the CLI level.
 */
export const CLAUDE_CONFIG_EDIT_GRANT = Object.freeze([
  "Edit(.claude/agents/*)",
  "Write(.claude/agents/*)",
  "Edit(.claude/rules/*)",
  "Write(.claude/rules/*)",
  "Edit(.claude/skills/*)",
  "Write(.claude/skills/*)"
]);

/**
 * Whether any pattern in `grantPatterns` (a resolved --allowedTools list, or any candidate list
 * being considered for one) would let Edit or Write touch `.claude/settings.json` or
 * `.claude/settings.local.json`. Used both as a regression guard on every real agent's resolved
 * grant and to validate any future candidate pattern before it is proposed.
 */
export function coversClaudeSettingsFile(grantPatterns) {
  return SENSITIVE_SETTINGS_FILES.some(
    (file) => isToolAllowed(`Edit(${file})`, grantPatterns) || isToolAllowed(`Write(${file})`, grantPatterns)
  );
}
