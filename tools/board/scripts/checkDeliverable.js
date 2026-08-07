#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { parseTask } from "../src/lib/taskParser.js";
import { checkDeliverable } from "../src/lib/deliverableCheck.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TASKS_DIR = path.join(REPO_ROOT, "tasks");
const ATTACHMENTS_DIR = path.join(TASKS_DIR, "attachments");

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("Usage: node checkDeliverable.js <T-NNNN>");
    process.exitCode = 1;
    return;
  }

  const raw = await fs.readFile(path.join(TASKS_DIR, `${id}.md`), "utf8");
  const task = parseTask(raw);
  const report = await checkDeliverable(task, { attachmentsDir: ATTACHMENTS_DIR });

  if (!report.applicable) {
    console.log(`${id}: deliverable_type is "${task.deliverable_type}", not "artifact" -- nothing to check.`);
    return;
  }
  if (report.ok) {
    console.log(
      `${id}: deliverable check passed -- ${task.attachments.length} attachment(s) recorded and present on disk.`
    );
    return;
  }

  console.error(`${id}: deliverable check FAILED.\n`);
  for (const message of report.errors) {
    console.error(`  ${message}`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
