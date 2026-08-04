import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentDef, loadRules } from "../../src/runner/configLoader.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REAL_AGENTS_DIR = path.join(REPO_ROOT, ".claude", "agents");
const REAL_RULES_DIR = path.join(REPO_ROOT, ".claude", "rules");

const INFRA_MD = `---
name: infra
description: Implements board tooling.
tools: Read, Write, Edit, Grep, Glob, Bash(node:*), Bash(npm:*), Bash(npx vitest:*), Bash(git:*)
model: sonnet
---

# infra

Body text.
`;

const JS_RULE_MD = `---
paths: ["tools/**"]
---

# JS conventions

ESM only.
`;

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

describe("loadAgentDef", () => {
  it("loads name/body/frontmatter for an agent definition", () => {
    const readFileFn = fixtureReader({ [path.join("/agents", "infra.md")]: INFRA_MD });
    const def = loadAgentDef("infra", { agentsDir: "/agents", readFileFn });

    expect(def.name).toBe("infra");
    expect(def.model).toBe("sonnet");
    expect(def.tools).toContain("Bash(git:*)");
    expect(def.body.trim()).toBe("# infra\n\nBody text.".trim());
  });

  it("throws when the agent file does not exist", () => {
    const readFileFn = fixtureReader({});
    expect(() => loadAgentDef("nope", { agentsDir: "/agents", readFileFn })).toThrow();
  });

  it("resolves every real agent definition in .claude/agents/", () => {
    for (const name of ["infra", "server", "client", "assets", "audio", "planner", "reviewer"]) {
      const def = loadAgentDef(name, { agentsDir: REAL_AGENTS_DIR });
      expect(def.name).toBe(name);
      expect(typeof def.body).toBe("string");
      expect(def.body.length).toBeGreaterThan(0);
    }
  });
});

describe("loadRules", () => {
  it("loads every rule file in a rules directory as {name, paths, body}", () => {
    const readdirFn = () => ["js.md"];
    const readFileFn = fixtureReader({ [path.join("/rules", "js.md")]: JS_RULE_MD });
    const rules = loadRules({ rulesDir: "/rules", readdirFn, readFileFn });

    expect(rules).toEqual([{ name: "js", paths: ["tools/**"], body: "\n# JS conventions\n\nESM only.\n" }]);
  });

  it("ignores non-markdown files in the rules directory", () => {
    const readdirFn = () => ["js.md", "README.txt", ".gitkeep"];
    const readFileFn = fixtureReader({ [path.join("/rules", "js.md")]: JS_RULE_MD });
    const rules = loadRules({ rulesDir: "/rules", readdirFn, readFileFn });

    expect(rules.map((r) => r.name)).toEqual(["js"]);
  });

  it("loads every real rule file in .claude/rules/", () => {
    const rules = loadRules({ rulesDir: REAL_RULES_DIR });
    const names = rules.map((r) => r.name).sort();
    expect(names).toEqual(["assets", "conduct", "cpp", "godot", "js", "planner", "python", "sql"]);
    const conduct = rules.find((r) => r.name === "conduct");
    expect(conduct.paths).toEqual(["**"]);
  });
});
