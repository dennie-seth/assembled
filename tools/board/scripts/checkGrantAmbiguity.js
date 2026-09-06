#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkAgentGrantsForNpmAmbiguity } from "../src/lib/npmGrantAmbiguity.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const AGENTS_DIR = path.join(REPO_ROOT, ".claude", "agents");
const BOARD_PACKAGE_JSON = path.join(REPO_ROOT, "tools", "board", "package.json");

function main() {
  const npmScripts = JSON.parse(fs.readFileSync(BOARD_PACKAGE_JSON, "utf8")).scripts;
  const report = checkAgentGrantsForNpmAmbiguity({ agentsDir: AGENTS_DIR, npmScripts });

  if (report.ok) {
    console.log("Grant ambiguity check passed: no agent grants an ambiguous npm-run wildcard.");
    return;
  }

  console.error(`Grant ambiguity check FAILED: ${report.violations.length} violation(s).\n`);
  for (const { agent, pattern, script, collisions } of report.violations) {
    console.error(
      `  ${agent}: "${pattern}" also authorises ${collisions.join(", ")} (a sibling of "${script}" sharing its literal prefix) -- use an exact-match grant with no trailing ":*" instead.`
    );
  }
  process.exitCode = 1;
}

main();
