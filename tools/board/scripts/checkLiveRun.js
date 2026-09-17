#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectLiveRun } from "../src/runner/liveRunGuard.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function main() {
  const repoRoot = process.argv[2] ? path.resolve(process.argv[2]) : REPO_ROOT;
  const runsDir = path.join(repoRoot, "tasks", ".runs");

  const result = await detectLiveRun({ runsDir, boardDirs: [repoRoot] });

  if (!result.live) {
    console.log("assembled-board deploy: no live card run detected, safe to proceed.");
    return;
  }

  const reasons = [];
  if (result.processLive) reasons.push(`a \`claude -p\` process is running under ${repoRoot} (pgrep -af claude)`);
  if (result.logGrowing) reasons.push("a tasks/.runs/*.jsonl file was written to in the last 2 minutes");
  console.error(`assembled-board deploy: refusing to deploy -- a card run looks live: ${reasons.join("; ")}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
