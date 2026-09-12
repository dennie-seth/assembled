import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveAllowedTools, isToolAllowed } from "../../src/runner/toolAllowlist.js";
import {
  CLAUDE_CONFIG_EDIT_GRANT,
  SENSITIVE_SETTINGS_FILES,
  coversClaudeSettingsFile
} from "../../src/runner/claudeSensitiveFileGrant.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REAL_AGENTS_DIR = path.join(REPO_ROOT, ".claude", "agents");

/**
 * T-0374: the Claude Code CLI's own sensitive-file safety check blocks any Edit/Write under
 * `.claude/` in a headless (`-p`) run, independent of `--allowedTools`, `--settings` permission
 * rules, `--permission-mode`, and even a `PreToolUse` hook that explicitly returns
 * `permissionDecision: "allow"` -- live-verified against the real CLI (v2.1.241, 2026-09-12) in
 * throwaway worktrees, and confirmed first-person on this very card (an `Edit` against this
 * worktree's own `.claude/agents/infra.md` was refused: "Claude requested permissions to write to
 * .../.claude/agents/infra.md, but you haven't granted it yet."). See
 * docs/design/claude-cli-sensitive-file-protection.md for the full reproduction table.
 *
 * There is therefore no working grant to wire into `.claude/agents/infra.md` -- unlike the
 * `referenceFetch.js` precedent (T-0276, tools/board/test/runner/referenceFetchGrant.test.js),
 * where the *only* blocked step was the one-time self-edit of `assets.md` and a human applying
 * that edit directly (never through a `claude -p` tool call) unblocked the grant for good. Here,
 * the grant's *target* (`.claude/agents/**` etc.) is itself the sensitive path, so even a
 * human-applied grant would be denied again at the next run that tried to use it (this is
 * empirically verified, not assumed -- see row 7 of the reproduction table).
 *
 * `CLAUDE_CONFIG_EDIT_GRANT` is kept as a documented, NOT-wired-into-any-agent candidate: the
 * narrowest pattern set that would express "infra may Edit/Write .claude/agents, .claude/rules,
 * .claude/skills" if the CLI ever honors it, with its settings-file exclusion unit-tested so it's
 * ready and correct the day that becomes possible. It is deliberately absent from every real
 * `.claude/agents/*.md` file today.
 */
describe("CLAUDE_CONFIG_EDIT_GRANT candidate pattern set", () => {
  it("never covers .claude/settings.json or .claude/settings.local.json", () => {
    expect(coversClaudeSettingsFile(CLAUDE_CONFIG_EDIT_GRANT)).toBe(false);
  });

  it.each(SENSITIVE_SETTINGS_FILES)("specifically excludes %s from Edit and Write", (settingsFile) => {
    expect(coversClaudeSettingsFile([`Edit(${settingsFile})`])).toBe(true); // sanity: detector fires on itself
    for (const pattern of CLAUDE_CONFIG_EDIT_GRANT) {
      expect(coversClaudeSettingsFile([pattern])).toBe(false);
    }
  });

  it("does match the three intended directories, so the pattern set is at least self-consistent", () => {
    const targets = [
      "Edit(.claude/agents/infra.md)",
      "Write(.claude/agents/new-agent.md)",
      "Edit(.claude/rules/js.md)",
      "Write(.claude/rules/new-rule.md)",
      "Edit(.claude/skills/verify/SKILL.md)",
      "Write(.claude/skills/new-skill/SKILL.md)"
    ];
    for (const target of targets) {
      expect(isToolAllowed(target, CLAUDE_CONFIG_EDIT_GRANT)).toBe(true);
    }
    // And the settings files stay excluded even alongside those matches.
    for (const settingsFile of SENSITIVE_SETTINGS_FILES) {
      expect(isToolAllowed(`Edit(${settingsFile})`, CLAUDE_CONFIG_EDIT_GRANT)).toBe(false);
      expect(isToolAllowed(`Write(${settingsFile})`, CLAUDE_CONFIG_EDIT_GRANT)).toBe(false);
    }
  });

  it("a naive .claude/** (or bare .claude/*) grant WOULD cover the settings files -- this is why CLAUDE_CONFIG_EDIT_GRANT names agents/rules/skills explicitly instead", () => {
    expect(coversClaudeSettingsFile(["Edit(.claude/*)", "Write(.claude/*)"])).toBe(true);
  });
});

describe("no real agent has been wired with the .claude/**-scoped candidate grant", () => {
  // T-0374 finding: no such grant works today (see docs/design/claude-cli-sensitive-file-protection.md),
  // so none should exist in any committed agent definition -- a grant that looks like a fix but
  // silently does nothing is worse than no grant at all. (Every agent's bare, unscoped Write/Edit
  // nominally "covers" any path by this repo's own naive prefix-match model -- same as it already
  // nominally covers server/**, client/**, assets/**, which is pre-existing, out-of-scope
  // architecture enforced by convention and reviewer audit, not by the tool grant itself. What
  // actually keeps .claude/settings*.json safe at runtime is the CLI's own hardcoded check
  // documented above, not anything expressible in --allowedTools -- so the meaningful thing to
  // pin here is that no agent has been handed an *explicit* .claude-scoped pattern, not that bare
  // Edit/Write somehow excludes it.)
  it.each(fs.readdirSync(REAL_AGENTS_DIR).filter((f) => f.endsWith(".md")))(
    "%s carries none of the CLAUDE_CONFIG_EDIT_GRANT patterns",
    (file) => {
      const agent = path.basename(file, ".md");
      const resolved = resolveAllowedTools(agent, { agentsDir: REAL_AGENTS_DIR });
      for (const pattern of CLAUDE_CONFIG_EDIT_GRANT) {
        expect(resolved).not.toContain(pattern);
      }
    }
  );

  it.each(fs.readdirSync(REAL_AGENTS_DIR).filter((f) => f.endsWith(".md")))(
    "%s never explicitly names .claude/settings.json or .claude/settings.local.json in any grant",
    (file) => {
      const agent = path.basename(file, ".md");
      const resolved = resolveAllowedTools(agent, { agentsDir: REAL_AGENTS_DIR });
      for (const settingsFile of SENSITIVE_SETTINGS_FILES) {
        expect(resolved.some((pattern) => pattern.includes(settingsFile))).toBe(false);
      }
    }
  );
});
