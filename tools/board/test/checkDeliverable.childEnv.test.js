import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DbTaskStore } from "../src/lib/db/dbTaskStore.js";
import { ClaudeCliRunner } from "../src/runner/claudeCliRunner.js";
import { makeTask } from "./taskStoreContract.js";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts/checkDeliverable.js"
);

let tmpDir;
let dbPath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-checkdeliverable-childenv-"));
  dbPath = path.join(tmpDir, "board.db");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seedArtifactTaskWithAttachment(id) {
  const store = new DbTaskStore(dbPath);
  await store.create(
    makeTask({
      id,
      deliverable_type: "artifact",
      attachments: [
        { filename: "sheet.png", size: 4, mimetype: "image/png", uploaded_by: "Dennie", uploaded_at: "2026-08-22T00:00:00.000Z" }
      ]
    })
  );
  store.close();

  const attachDir = path.join(tmpDir, "attachments", id);
  await fs.mkdir(attachDir, { recursive: true });
  await fs.writeFile(path.join(attachDir, "sheet.png"), "fake");
}

/**
 * These two tests reproduce the actual live failure: reviewer/implementer `claude` CLI
 * children invoke `scripts/checkDeliverable.js` themselves via their own Bash tool, so
 * whatever env ClaudeCliRunner.buildEnv() decides to pass through is *all* the env that
 * script's own `process.env.BOARD_TASK_STORE` check ever sees -- it never sees the parent
 * board process's env directly. Simulating the child's exact env (via buildEnv(), not by
 * hand) is what proves the fix closes the real gap rather than a proxy for it.
 */
describe("checkDeliverable.js in a child process spawned with only the ClaudeCliRunner-allowlisted env", () => {
  it("resolves DB-mode attachments (not fs) when BOARD_TASK_STORE/BOARD_DB_PATH are in the allowlist", async () => {
    await seedArtifactTaskWithAttachment("T-9001");

    const runner = new ClaudeCliRunner({
      hostEnv: { PATH: process.env.PATH, BOARD_TASK_STORE: "db", BOARD_DB_PATH: dbPath }
    });
    const childEnv = runner.buildEnv();
    expect(childEnv.BOARD_TASK_STORE).toBe("db");

    const { stdout } = await execFileAsync(process.execPath, [SCRIPT_PATH, "T-9001"], { env: childEnv });
    expect(stdout).toMatch(/deliverable check passed/);
  });

  it("regression guard: without BOARD_TASK_STORE passed through, the child silently falls back to fs mode and fails to find the db-mode-only card -- the exact bug this fix closes", async () => {
    await seedArtifactTaskWithAttachment("T-9002");

    // Mirrors the pre-fix DEFAULT_ENV_ALLOWLIST (PATH/HOME/LANG/LC_ALL/TERM/TZ only) -- no
    // BOARD_TASK_STORE, no BOARD_DB_PATH, even though the host process is running in db mode.
    const runner = new ClaudeCliRunner({
      envAllowlist: ["PATH"],
      hostEnv: { PATH: process.env.PATH, BOARD_TASK_STORE: "db", BOARD_DB_PATH: dbPath }
    });
    const childEnv = runner.buildEnv();
    expect(childEnv.BOARD_TASK_STORE).toBeUndefined();

    await expect(execFileAsync(process.execPath, [SCRIPT_PATH, "T-9002"], { env: childEnv })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/no such task found/)
    });
  });
});
