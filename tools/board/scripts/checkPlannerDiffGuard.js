#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectTasksDiff, checkPlannerDiffGuard } from "../src/lib/plannerDiffGuard.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function main() {
  if ((process.env.BOARD_TASK_STORE || "fs") === "db") {
    // In db mode there is no tasks/*.md file for a git diff to inspect -- the planner's
    // ephemeral file view is reconciled and guardrail-checked at the application layer instead
    // (see src/runner/plannerFileView.js's diffPlannerFileView, which runs this same
    // checkPlannerDiffGuard logic against two in-memory snapshots during every planner run).
    // This script has nothing to check here; report a clean no-op rather than a false failure.
    console.log(
      "Planner diff guard: BOARD_TASK_STORE=db -- card state lives in SQLite, not git, so this git-diff-based check is a no-op in db mode. The orchestrator enforces the same guardrails at the application layer during planner runs."
    );
    return;
  }

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
