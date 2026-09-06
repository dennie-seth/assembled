import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/checkApproval.js");

/**
 * End-to-end coverage for `scripts/checkApproval.js` (T-0307): a real HTTP board server plus a
 * real, stale ledger fixture on disk, driven exactly as an agent would invoke the script. Proves
 * the CLI wiring, not just the underlying `checkApproval()` unit -- BOARD_BASE_URL / ledger-path
 * plumbing, exit codes, and stdout/stderr shape.
 */

let tasksDir;
let store;
let server;
let baseUrl;
let ledgerPath;
let workDir;

beforeEach(async () => {
  tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-checkapproval-e2e-"));
  store = new FsTaskStore(tasksDir);
  const idAllocator = new IdAllocator(tasksDir);
  server = await startHttpServer({ store, idAllocator, tasksDir, repoRoot: "/fake/repo", port: 0 });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-checkapproval-ledger-"));
  ledgerPath = path.join(workDir, "approval-ledger.json");
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tasksDir, { recursive: true, force: true });
  await fs.rm(workDir, { recursive: true, force: true });
});

async function createTask(overrides = {}) {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Board-Actor": "board-ui" },
    body: JSON.stringify({ title: "Fixture card", phase: 1, ...overrides })
  });
  return res.json();
}

async function writeLedger(cards, generatedAt) {
  await fs.writeFile(ledgerPath, JSON.stringify({ version: 1, generated_at: generatedAt, cards }, null, 2), "utf8");
}

function runScript(taskId) {
  return execFileAsync(process.execPath, [SCRIPT_PATH, taskId], {
    env: { ...process.env, BOARD_BASE_URL: baseUrl, BOARD_APPROVAL_LEDGER: ledgerPath }
  }).then(
    (r) => ({ code: 0, ...r }),
    (err) => ({ code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" })
  );
}

describe("checkApproval.js (end-to-end)", () => {
  it("exits 0 and reports approved when the live board is approved, despite a stale ledger saying otherwise", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });
    await fetch(`${baseUrl}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" })
    });
    // A ledger generated a long time ago, still claiming no approval.
    await writeLedger([{ id: task.id, requires_approval: true, approved_by: null, approved_at: null }], "2020-01-01T00:00:00.000Z");

    const { code, stdout } = await runScript(task.id);

    expect(code).toBe(0);
    const verdict = JSON.parse(stdout);
    expect(verdict.approved).toBe(true);
    expect(verdict.source).toBe("board-api");
  });

  it("exits 1 when the card genuinely is not approved yet", async () => {
    const task = await createTask({ requires_approval: true, status: "review" });
    await writeLedger([{ id: task.id, requires_approval: true, approved_by: null, approved_at: null }], "2020-01-01T00:00:00.000Z");

    const { code, stdout } = await runScript(task.id);

    expect(code).toBe(1);
    const verdict = JSON.parse(stdout);
    expect(verdict.approved).toBe(false);
    expect(verdict.verified).toBe(true);
  });

  it("exits 0 for a card that doesn't require approval, with no ledger present at all", async () => {
    const task = await createTask();

    const { code, stdout } = await runScript(task.id);

    expect(code).toBe(0);
    const verdict = JSON.parse(stdout);
    expect(verdict.requiresApproval).toBe(false);
  });
});
