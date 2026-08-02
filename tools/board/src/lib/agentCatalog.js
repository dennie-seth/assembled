import { promises as fs } from "node:fs";
import path from "node:path";
import { ASSIGNABLE_AGENT_NAMES } from "./taskParser.js";

/** Lists agent names in agentsDir that are valid values for a task's `agent` field (excludes reviewer). */
export async function listAssignableAgents(agentsDir) {
  let entries;
  try {
    entries = await fs.readdir(agentsDir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => path.basename(entry, ".md"))
    .filter((name) => ASSIGNABLE_AGENT_NAMES.includes(name))
    .sort();
}
