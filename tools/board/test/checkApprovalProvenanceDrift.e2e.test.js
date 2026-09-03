import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts/checkApprovalProvenanceDrift.js"
);

/**
 * End-to-end coverage for `checkApprovalProvenanceDrift.js` (T-0286 run-2 review): the prior
 * suite only ever unit-tested `findApprovalDrift` with in-memory objects, which proves the pure
 * function works but says nothing about the actual CLI script the CI workflow runs -- data
 * loading (`FsTaskStore` over real `tasks/*.md` files) and the new git-diff scoping were both
 * unexercised. This drives the real script as a subprocess against a real fixture git repo, the
 * same way CI invokes it, with `BOARD_TASKS_DIR`/`BOARD_GIT_CWD` pointed at the fixture instead
 * of this repo's own `tasks/`/`ASSET_PROVENANCE.md`.
 */
async function git(args, cwd) {
  await execFileAsync("git", args, { cwd });
}

function task({ id, requiresApproval = false, approvedBy = null, approvedAt = null }) {
  return (
    `---\n` +
    `id: ${id}\n` +
    `title: Fixture card ${id}\n` +
    `status: ${approvedBy ? "done" : "review"}\n` +
    `priority: P2\n` +
    `phase: 6\n` +
    `agent: infra\n` +
    `depends_on: []\n` +
    `created: 2026-08-01\n` +
    `requires_approval: ${requiresApproval}\n` +
    `approved_by: ${approvedBy ? JSON.stringify(approvedBy) : "null"}\n` +
    `approved_at: ${approvedAt ? JSON.stringify(approvedAt) : "null"}\n` +
    `---\n\nFixture body.\n`
  );
}

async function runScript({ cwd, provenancePath, baseRef, env = {} }) {
  try {
    const { stdout } = await execFileAsync(
      "node",
      [SCRIPT_PATH, provenancePath, baseRef],
      {
        cwd,
        env: {
          ...process.env,
          BOARD_TASK_STORE: "fs",
          BOARD_TASKS_DIR: path.join(cwd, "tasks"),
          BOARD_GIT_CWD: cwd,
          ...env
        }
      }
    );
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("checkApprovalProvenanceDrift.js (end-to-end)", () => {
  let repoDir;
  let tasksDir;
  let provenancePath;
  let baseRef;

  beforeAll(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "board-drift-e2e-"));
    tasksDir = path.join(repoDir, "tasks");
    provenancePath = path.join(repoDir, "ASSET_PROVENANCE.md");
    await mkdir(tasksDir, { recursive: true });

    await git(["init", "-q"], repoDir);
    await git(["config", "user.email", "test@example.com"], repoDir);
    await git(["config", "user.name", "Test"], repoDir);

    // Base: one gated card, approved on the board, provenance row already correct; one
    // pre-existing row referencing a card this fixture's tasks/ dir has never heard of --
    // proves history is never re-flagged just because a later PR is unrelated.
    await writeFile(path.join(tasksDir, "T-0001.md"), task({ id: "T-0001" }));
    await writeFile(
      provenancePath,
      "| a.png (T-0001) | MIT | ... |\n" +
        "| old.png (T-8888 -- not yet approved) | MIT | ... |\n"
    );
    await git(["add", "-A"], repoDir);
    await git(["commit", "-q", "-m", "base"], repoDir);
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    baseRef = stdout.trim();
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("passes clean when nothing has drifted", async () => {
    const result = await runScript({ cwd: repoDir, provenancePath, baseRef });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("passed");
  });

  it("reproduces the T-0243 scenario end-to-end: approved on the board, provenance row newly added but stale", async () => {
    await writeFile(path.join(tasksDir, "T-0257.md"), task({ id: "T-0257", requiresApproval: true, approvedBy: "Anonymous", approvedAt: "2026-08-30T22:06:35.073Z" }));
    await writeFile(
      provenancePath,
      "| a.png (T-0001) | MIT | ... |\n" +
        "| old.png (T-8888 -- not yet approved) | MIT | ... |\n" +
        "| signal_tower.png (T-0257 -- not yet approved) | MIT | ... |\n"
    );
    await git(["add", "-A"], repoDir);
    await git(["commit", "-q", "-m", "add stale T-0257 row"], repoDir);

    const result = await runScript({ cwd: repoDir, provenancePath, baseRef });

    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain("T-0257");
    expect(result.stdout + result.stderr).toContain("stale-unapproved-claim");

    // Clean up so later tests in this suite diff from a clean HEAD again.
    await git(["revert", "--no-edit", "HEAD"], repoDir);
  });

  it("is loud, not a silent pass, when a newly-added row claims approval for a card the data source cannot resolve", async () => {
    await writeFile(
      provenancePath,
      "| a.png (T-0001) | MIT | ... |\n" +
        "| old.png (T-8888 -- not yet approved) | MIT | ... |\n" +
        "| brand_new.png (T-9999 -- not yet approved) | MIT | ... |\n"
    );
    await git(["add", "-A"], repoDir);
    await git(["commit", "-q", "-m", "add unresolvable T-9999 row"], repoDir);

    const result = await runScript({ cwd: repoDir, provenancePath, baseRef });

    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain("T-9999");
    expect(result.stdout + result.stderr).toContain("unverifiable-approval-claim");
    // The pre-existing T-8888 row is untouched by this diff and must stay silent.
    expect(result.stdout + result.stderr).not.toContain("T-8888");

    await git(["revert", "--no-edit", "HEAD"], repoDir);
  });
});
