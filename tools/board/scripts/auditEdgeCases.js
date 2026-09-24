#!/usr/bin/env node
import { auditEdgeCasesCoverage } from "../src/lib/edgeCasesAudit.js";
import { readBacklogEntries, DEFAULT_TASKS_DIR } from "../src/lib/backlogValidator.js";
import { parseTask } from "../src/lib/taskParser.js";
import { openDb } from "../src/lib/db/connection.js";
import { DbTaskStore } from "../src/lib/db/dbTaskStore.js";

/**
 * Re-runnable version of the T-0408 card's by-hand audit: how many cards carry a real bold
 * `**Edge cases:**` block (with its own checklist items) inside `## Acceptance`, counted by
 * `hasEdgeCasesBlock` -- the label line itself, never a mention of the phrase elsewhere in the
 * body. `BOARD_TASK_STORE=db` reads the live DB backlog, same convention as validateBacklog.js.
 */
async function loadTasks() {
  if ((process.env.BOARD_TASK_STORE || "fs") === "db") {
    const db = openDb();
    try {
      const store = new DbTaskStore(db);
      return await store.list();
    } finally {
      db.close();
    }
  }
  const entries = await readBacklogEntries(DEFAULT_TASKS_DIR);
  const tasks = [];
  for (const { raw } of entries) {
    try {
      tasks.push(parseTask(raw));
    } catch {
      // A malformed card is validateBacklog.js's problem to report, not this audit's --
      // skip it rather than crash the count.
    }
  }
  return tasks;
}

function formatRow(label, group) {
  return `${label.padEnd(16)} ${String(group.cards).padStart(5)}  ${String(group.withBlock).padStart(10)}`;
}

async function main() {
  const tasks = await loadTasks();
  const report = auditEdgeCasesCoverage(tasks);

  console.log(
    "Edge cases coverage audit -- counts a real **Edge cases:** label line with its own\n" +
      "checklist item(s) inside ## Acceptance only, never a mention elsewhere in the body\n" +
      "(tools/board/src/lib/edgeCasesAudit.js#hasEdgeCasesBlock).\n"
  );
  console.log(`${"".padEnd(16)} cards  with block`);
  console.log(formatRow("whole board", report.total));
  console.log(formatRow(`newest ${report.newest.n}`, report.newest));
  console.log("");
  console.log("by agent:");
  const agents = Object.keys(report.byAgent).sort();
  for (const agent of agents) {
    console.log(formatRow(agent, report.byAgent[agent]));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
