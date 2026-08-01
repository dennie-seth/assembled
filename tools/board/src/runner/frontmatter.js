import yaml from "js-yaml";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Shared `--- yaml ---\nbody` splitter for .claude/agents/*.md and
 * .claude/rules/*.md, mirroring the task-md frontmatter convention in
 * taskParser.js.
 */
export function splitFrontmatter(raw) {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new Error("File is missing frontmatter delimiters (--- ... ---)");
  }
  const [, yamlText, body] = match;

  let data;
  try {
    data = yaml.load(yamlText);
  } catch (err) {
    throw new Error(`Frontmatter is not valid YAML: ${err.message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Frontmatter must be a YAML mapping");
  }

  return { data, body };
}
