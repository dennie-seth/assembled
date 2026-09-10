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
import { PRE_REGISTRATION_HEADING } from "../src/lib/preRegisteredFinding.js";

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

/**
 * T-0352: checkDeliverable.js's default `listCommittedFiles` runs real `git ls-files` against
 * this checkout's own repo root, so an attachment filename must actually correspond to a
 * git-committed file for the deliverable check to pass -- `package.json` (real, committed,
 * present at `tools/board/package.json`) stands in for a genuine deliverable here; these tests
 * exercise DB-mode attachment/env resolution, not deliverable-correctness semantics, which
 * `deliverableCheck.test.js` covers directly with an injected `listCommittedFiles`.
 */
async function seedArtifactTaskWithAttachment(id) {
  const store = new DbTaskStore(dbPath);
  await store.create(
    makeTask({
      id,
      deliverable_type: "artifact",
      attachments: [
        { filename: "package.json", size: 4, mimetype: "image/png", uploaded_by: "Dennie", uploaded_at: "2026-08-22T00:00:00.000Z" }
      ]
    })
  );
  store.close();

  const attachDir = path.join(tmpDir, "attachments", id);
  await fs.mkdir(attachDir, { recursive: true });
  await fs.writeFile(path.join(attachDir, "package.json"), "fake");
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

/**
 * T-0342: db-mode end-to-end exercise of the finding-with-evidence route -- the exact gap the
 * reviewer's FAIL flagged. checkDeliverable.js used to hardcode beforeBody = "" whenever
 * BOARD_TASK_STORE=db, which is production (boardServer.js), so this route was dead code for
 * every real card. These tests drive a DbTaskStore through the real runOrchestrator status
 * sequence (in-progress -> validation, the moment the reviewer -- and this script -- actually
 * runs) via the same env-restricted child process the tests above use, then assert on the
 * script's real exit code/stdout/stderr, not on internal function calls.
 */
describe("checkDeliverable.js in db mode: finding-with-evidence route (T-0342)", () => {
  async function runScript(id, env) {
    return execFileAsync(process.execPath, [SCRIPT_PATH, id], { env });
  }

  function dbEnv() {
    const runner = new ClaudeCliRunner({
      hostEnv: { PATH: process.env.PATH, BOARD_TASK_STORE: "db", BOARD_DB_PATH: dbPath }
    });
    return runner.buildEnv();
  }

  it("PASSes on a decisive, evidenced finding when pre-registration predates the current run's in-progress transition", async () => {
    const preRegisteredBody = `${PRE_REGISTRATION_HEADING}\nIf X, arm falsified.\n`;
    // checkDeliverable.js resolves repoRoot from its own script location, not from the
    // env/cwd -- so cited evidence must actually exist under this checkout's real repo root for
    // the finding-with-evidence route to PASS, exactly as it would for a real reviewer run.
    // Written under os.tmpdir()-namespaced subpaths of a real (gitignored-by-pattern) directory
    // and removed in the `finally` below regardless of outcome.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const evidenceRelPath = path.join(
      "docs", "assets", "evidence", `t0342-childenv-test-${process.pid}`, "attempt_1.png"
    );
    const evidenceAbsPath = path.join(repoRoot, evidenceRelPath);

    const store = new DbTaskStore(dbPath);
    await store.create(
      makeTask({ id: "T-9201", deliverable_type: "artifact", status: "ready", attachments: [], body: preRegisteredBody })
    );
    await store.update("T-9201", { status: "in-progress" });
    await store.update("T-9201", {
      body: `${preRegisteredBody}\n## Finding\nThe result is decisive: falsified. See \`${evidenceRelPath.split(path.sep).join("/")}\`.\n`
    });
    await store.update("T-9201", { status: "validation" });
    store.close();

    await fs.mkdir(path.dirname(evidenceAbsPath), { recursive: true });
    await fs.writeFile(evidenceAbsPath, "fake evidence bytes");

    try {
      const { stdout } = await runScript("T-9201", dbEnv());
      expect(stdout).toMatch(/deliverable check passed/);
      expect(stdout).toMatch(/pre-registered experiment/);
    } finally {
      await fs.rm(path.dirname(evidenceAbsPath), { recursive: true, force: true });
    }
  });

  it("still FAILs (no attachments, no reachable pre-registration) when the pre-registered-experiment section is added only during the current run", async () => {
    const store = new DbTaskStore(dbPath);
    await store.create(makeTask({ id: "T-9202", deliverable_type: "artifact", status: "ready", attachments: [], body: "## Context\nnothing yet\n" }));
    await store.update("T-9202", { status: "in-progress" });
    await store.update("T-9202", {
      body: `${PRE_REGISTRATION_HEADING}\nadded retroactively\n\n## Finding\ndecisive, see \`evidence.png\`\n`
    });
    await store.update("T-9202", { status: "validation" });
    store.close();

    await expect(runScript("T-9202", dbEnv())).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/no attachments recorded/)
    });
  });

  it("still FAILs when there is no artifact and no pre-registered finding at all (baseline db-mode behaviour unchanged)", async () => {
    const store = new DbTaskStore(dbPath);
    await store.create(makeTask({ id: "T-9203", deliverable_type: "artifact", status: "ready", attachments: [], body: "## Context\nplain card\n" }));
    await store.update("T-9203", { status: "in-progress" });
    await store.update("T-9203", { status: "validation" });
    store.close();

    await expect(runScript("T-9203", dbEnv())).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/no attachments recorded/)
    });
  });
});
