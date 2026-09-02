import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveAllowedTools, isToolAllowed } from "../../src/runner/toolAllowlist.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REAL_AGENTS_DIR = path.join(REPO_ROOT, ".claude", "agents");
const WRAPPER = path.join(REPO_ROOT, "tools", "board", "scripts", "referenceFetch.js");

const REFERENCE_FETCH_GRANTED_AGENTS = ["assets"];

/**
 * T-0276 review run 1: the library and CLI for scoped reference sourcing were complete and
 * tested, but no agent was actually granted the wrapper -- `.claude/agents/assets.md` never
 * listed it, so the `assets` agent had no way to invoke `referenceFetch.js` at all. A documented
 * intention to add a grant (docs/reference-sourcing-security.md) is not the grant. This mirrors
 * `agentCurlGrant.test.js`, which exists for the identical failure mode on `agentCurl.js` (T-0221).
 *
 * The three tests below that assert the grant *itself* were `.skip`-ed across review runs 2-5
 * because an implementer agent editing `.claude/agents/assets.md` -- the file defining its own
 * Bash grants -- is refused outright by the Claude Code CLI's own self-grant guardrail, which no
 * board-side change can lift. A human applied the grant directly in PR #301 (8f81380, merged to
 * `develop` as d7d02e8) and it has now been merged into this branch, so the grant is live and
 * these assertions run for real again.
 */
describe("agent grants: referenceFetch.js wrapper", () => {
  it("the wrapper the grant names actually exists at that path", () => {
    expect(fs.existsSync(WRAPPER)).toBe(true);
  });

  it.each(REFERENCE_FETCH_GRANTED_AGENTS)("%s is granted the scoped referenceFetch.js wrapper", (agent) => {
    const resolved = resolveAllowedTools(agent, { agentsDir: REAL_AGENTS_DIR });
    expect(resolved).toContain("Bash(node tools/board/scripts/referenceFetch.js:*)");
    // The prefix grant must actually match the real invocation shapes the CLI supports.
    expect(
      isToolAllowed('Bash(node tools/board/scripts/referenceFetch.js:search wikimedia "front elevation reference" 10)', resolved)
    ).toBe(true);
    expect(
      isToolAllowed(
        "Bash(node tools/board/scripts/referenceFetch.js:fetch wikimedia File:Example.jpg assets/src/reference/quarantine)",
        resolved
      )
    ).toBe(true);
  });

  it.each(fs.readdirSync(REAL_AGENTS_DIR).filter((f) => f.endsWith(".md")))(
    "%s is not granted referenceFetch.js unless explicitly listed",
    (file) => {
      const agent = path.basename(file, ".md");
      const resolved = resolveAllowedTools(agent, { agentsDir: REAL_AGENTS_DIR });
      if (REFERENCE_FETCH_GRANTED_AGENTS.includes(agent)) {
        expect(resolved).toContain("Bash(node tools/board/scripts/referenceFetch.js:*)");
      } else {
        expect(resolved).not.toContain("Bash(node tools/board/scripts/referenceFetch.js:*)");
      }
    }
  );

  it("assets still has no raw curl/browsing grant of its own -- only the two named wrappers", () => {
    const resolved = resolveAllowedTools("assets", { agentsDir: REAL_AGENTS_DIR });
    expect(resolved.some((t) => /^Bash\(curl[\s:)]/.test(t))).toBe(false);
    expect(resolved.some((t) => /^(WebFetch|WebSearch)\b/.test(t))).toBe(false);
  });
});

/**
 * Same regression class as agentCurlGrant.test.js's "documented ... invocations are runnable as
 * written": a doc line that uses `${}` substitution or an absolute path looks fine to a human but
 * cannot actually run under the runner's Bash tool / prefix-match grant. Un-skipped now that PR
 * #301 has written the doc bullet in `.claude/rules/assets.md` and merged it into this branch.
 */
describe("documented referenceFetch.js invocations are runnable as written", () => {
  const DOC_FILES = [path.join(REPO_ROOT, ".claude", "agents", "assets.md"), path.join(REPO_ROOT, ".claude", "rules", "assets.md")];

  const wrapperLines = (file) =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.replace(/`/g, "").trim())
      .filter((line) => line.startsWith("node ") && line.includes("referenceFetch.js"));

  it("at least one of the assets docs documents a referenceFetch.js invocation", () => {
    const total = DOC_FILES.reduce((sum, file) => sum + wrapperLines(file).length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it.each(DOC_FILES)("%s never shows ${} substitution the Bash tool refuses", (file) => {
    for (const line of wrapperLines(file)) {
      expect(line).not.toMatch(/\$\{/);
    }
  });

  it.each(DOC_FILES)("%s invokes the wrapper by the repo-relative path the grant matches", (file) => {
    const resolved = resolveAllowedTools("assets", { agentsDir: REAL_AGENTS_DIR });
    for (const line of wrapperLines(file)) {
      const invocation = line.slice(line.indexOf("node "));
      expect(invocation.startsWith("node tools/board/scripts/referenceFetch.js")).toBe(true);
      const [, ...args] = invocation.split(/\s+/);
      expect(isToolAllowed(`Bash(node ${args[0]}:${args.slice(1).join(" ")})`, resolved)).toBe(true);
    }
  });
});
