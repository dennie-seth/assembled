import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findAmbiguousNpmRunGrants,
  checkAgentGrantsForNpmAmbiguity
} from "../src/lib/npmGrantAmbiguity.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const REAL_AGENTS_DIR = path.join(REPO_ROOT, ".claude", "agents");
const REAL_PACKAGE_JSON = path.join(REPO_ROOT, "tools", "board", "package.json");

function readRealNpmScripts() {
  return JSON.parse(fs.readFileSync(REAL_PACKAGE_JSON, "utf8")).scripts;
}

function fixtureReader(files) {
  return (p) => {
    if (!(p in files)) {
      const err = new Error(`ENOENT: no such file, open '${p}'`);
      err.code = "ENOENT";
      throw err;
    }
    return files[p];
  };
}

describe("findAmbiguousNpmRunGrants", () => {
  const NPM_SCRIPTS = {
    "test:browser": "playwright test",
    "test:browser:install": "playwright install chromium",
    lint: "eslint ."
  };

  it("T-0295: flags a wildcarded npm-run grant whose stripped prefix is also a literal prefix of a sibling script", () => {
    // The exact shape of the bug a T-0295 reviewer VALIDATION round caught by hand:
    // `Bash(npm run test:browser:*)` strips to the raw prefix "npm run test:browser:", which the
    // literal string "npm run test:browser:install" also starts with -- so the wildcard silently
    // authorises a second, unrelated script (a ~390MB browser download) that was never meant to
    // be granted. See isToolAllowed in ../src/runner/toolAllowlist.js for the matching semantics
    // this reproduces.
    const violations = findAmbiguousNpmRunGrants(["Bash(npm run test:browser:*)"], NPM_SCRIPTS);
    expect(violations).toEqual([
      {
        pattern: "Bash(npm run test:browser:*)",
        script: "test:browser",
        collisions: ["test:browser:install"]
      }
    ]);
  });

  it("does not flag an exact-match grant (no trailing wildcard) for the same script", () => {
    const violations = findAmbiguousNpmRunGrants(["Bash(npm run test:browser)"], NPM_SCRIPTS);
    expect(violations).toEqual([]);
  });

  it("does not flag a wildcarded grant for a script with no colon-prefixed sibling", () => {
    const violations = findAmbiguousNpmRunGrants(["Bash(npm run lint:*)"], NPM_SCRIPTS);
    expect(violations).toEqual([]);
  });

  it("ignores non-`npm run` grants entirely", () => {
    const violations = findAmbiguousNpmRunGrants(
      ["Bash(npm:*)", "Bash(node:*)", "Read", "Bash(git:*)"],
      NPM_SCRIPTS
    );
    expect(violations).toEqual([]);
  });
});

describe("checkAgentGrantsForNpmAmbiguity", () => {
  const NPM_SCRIPTS = {
    "test:browser": "playwright test",
    "test:browser:install": "playwright install chromium"
  };

  it("reports a violation with the offending agent name", () => {
    const readFileFn = fixtureReader({
      "/agents/client.md": `---
name: client
description: Implements the client.
tools: Read, Write, Edit, Bash(npm run test:browser:*), Bash(git:*)
---

# client
`
    });

    const report = checkAgentGrantsForNpmAmbiguity({
      agentsDir: "/agents",
      npmScripts: NPM_SCRIPTS,
      readFileFn,
      listAgentsFn: () => ["client"]
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([
      {
        agent: "client",
        pattern: "Bash(npm run test:browser:*)",
        script: "test:browser",
        collisions: ["test:browser:install"]
      }
    ]);
  });

  it("passes when every agent's npm-run grants are exact-match or unambiguous", () => {
    const readFileFn = fixtureReader({
      "/agents/client.md": `---
name: client
description: Implements the client.
tools: Read, Write, Edit, Bash(npm run test:browser), Bash(git:*)
---

# client
`
    });

    const report = checkAgentGrantsForNpmAmbiguity({
      agentsDir: "/agents",
      npmScripts: NPM_SCRIPTS,
      readFileFn,
      listAgentsFn: () => ["client"]
    });

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("regression guard: no real .claude/agents/*.md grant is an ambiguous npm-run wildcard against the real package.json scripts", () => {
    const agentNames = fs
      .readdirSync(REAL_AGENTS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));

    const report = checkAgentGrantsForNpmAmbiguity({
      agentsDir: REAL_AGENTS_DIR,
      npmScripts: readRealNpmScripts(),
      listAgentsFn: () => agentNames
    });

    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
