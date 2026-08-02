#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectTasksDiff, checkPlannerDiffGuard } from "../src/lib/plannerDiffGuard.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function main() {
  const baseRef = process.argv[2] || "develop";
  const changes = await collectTasksDiff({ cwd: REPO_ROOT, baseRef });
  const report = checkPlannerDiffGuard(changes);

  if (report.ok) {
    console.log(
      `Planner diff guard passed against ${baseRef}: ${changes.length} tasks/ file(s) changed, no status/deletion violations.`
    );
    return;
  }

  console.error(`Planner diff guard FAILED against ${baseRef}: ${report.violations.length} violation(s).\n`);
  for (const { file, message } of report.violations) {
    console.error(`  ${file}: ${message}`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
