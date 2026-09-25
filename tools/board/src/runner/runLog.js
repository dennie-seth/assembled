import { promises as fs } from "node:fs";
import path from "node:path";

function formatTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Persists a run's parsed event stream verbatim to
 * tasks/.runs/T-NNNN-<timestamp>.jsonl (append-only NDJSON), independent of
 * the summarized WS log pane — the audit trail for what a run actually did.
 */
export async function createRunLog({ runsDir, taskId, now = () => new Date() }) {
  await fs.mkdir(runsDir, { recursive: true });
  const runId = `${taskId}-${formatTimestamp(now())}`;
  const filePath = path.join(runsDir, `${runId}.jsonl`);
  const handle = await fs.open(filePath, "a");

  return {
    path: filePath,
    // T-0396: the same id this run's own log is named after, threaded through to the spawned
    // child as BOARD_RUN_ID (see claudeCliRunner.js) so a committed attempt frame can always be
    // traced back to the run log that produced it.
    runId,
    async append(event) {
      await handle.appendFile(`${JSON.stringify(event)}\n`, "utf8");
    },
    async close() {
      await handle.close();
    }
  };
}

export async function readRunLog(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}
