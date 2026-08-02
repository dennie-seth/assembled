import fs from "node:fs";
import path from "node:path";
import { splitFrontmatter } from "./frontmatter.js";

/** Loads .claude/agents/<name>.md into {name, body, ...frontmatter} (tools, model, description). */
export function loadAgentDef(name, { agentsDir = ".claude/agents", readFileFn = fs.readFileSync } = {}) {
  const raw = readFileFn(path.join(agentsDir, `${name}.md`), "utf8");
  const { data, body } = splitFrontmatter(raw);
  return { name, body, ...data };
}

/** Loads every .claude/rules/*.md file into {name, paths, body} entries. */
export function loadRules({
  rulesDir = ".claude/rules",
  readdirFn = fs.readdirSync,
  readFileFn = fs.readFileSync
} = {}) {
  const entries = readdirFn(rulesDir).filter((entry) => entry.endsWith(".md"));
  return entries.map((entry) => {
    const raw = readFileFn(path.join(rulesDir, entry), "utf8");
    const { data, body } = splitFrontmatter(raw);
    return { name: path.basename(entry, ".md"), paths: data.paths ?? [], body };
  });
}
