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
    const { stdout, stderr } = await execFileAsync(
      "node",
      [SCRIPT_PATH, provenancePath, baseRef],
      {
        cwd,
        env: {
          ...process.env,
          BOARD_TASK_STORE: "fs",
          BOARD_TASKS_DIR: path.join(cwd, "tasks"),
          BOARD_GIT_CWD: cwd,
          // Default to a ledger path that can never resolve, so a test that doesn't care about
          // the ledger fallback never accidentally reads THIS repo's real, committed
          // tools/board/approval-ledger.json (whose real age/content is a moving target this
          // suite must never depend on -- see T-0313). Tests exercising the fallback override it.
          BOARD_APPROVAL_LEDGER: path.join(cwd, "__no_ledger_by_default__.json"),
          ...env
        }
      }
    );
    return { code: 0, stdout, stderr };
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

  it(
    "T-0313: a stale ledger never fails the gate when the live store already resolved every id -- " +
      "not load-bearing, so staleness alone is not an error",
    async () => {
      const ledgerPath = path.join(repoDir, "ancient-but-irrelevant-ledger.json");
      await writeFile(
        ledgerPath,
        JSON.stringify({
          version: 1,
          generated_at: "2020-01-01T00:00:00.000Z",
          // T-0001 is already resolvable via tasksDir's own T-0001.md -- mergeTasksWithLedger's
          // `seen` guard means this ledger entry is never actually used, however old it is.
          cards: [{ id: "T-0001", requires_approval: true, approved_by: null, approved_at: null }]
        })
      );

      const result = await runScript({ cwd: repoDir, provenancePath, baseRef, env: { BOARD_APPROVAL_LEDGER: ledgerPath } });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("passed");
      // Confirms the ledger was genuinely not load-bearing, not just silently ignored.
      expect(result.stdout + result.stderr).not.toContain("ledger supplied");
    }
  );
});

/**
 * T-0292: the suite above proves the script still fails closed when a card is unresolvable, but
 * every case in it runs with no `BOARD_APPROVAL_LEDGER` at all -- it never exercises the ledger
 * fallback (`approvalLedger.js`) that `checkApprovalProvenanceDrift.js` actually wires in for CI.
 * `approvalLedger.test.js` unit-tests `mergeTasksWithLedger`/`findApprovalDrift` directly with
 * in-memory objects, which proves the merge logic works but says nothing about the real CLI
 * script's env var wiring, default path resolution, or stdout/stderr framing -- the exact gap
 * that would have hidden a wiring bug (e.g. an env var name typo) from every existing test. This
 * drives the real script as a subprocess with `BOARD_APPROVAL_LEDGER` pointed at fixture ledger
 * files, the same way it would be pointed at the real committed
 * `tools/board/approval-ledger.json` in CI.
 */
describe("checkApprovalProvenanceDrift.js (end-to-end): the approval-ledger fallback", () => {
  let repoDir;
  let tasksDir;
  let provenancePath;
  let baseRef;

  beforeAll(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "board-drift-ledger-e2e-"));
    tasksDir = path.join(repoDir, "tasks");
    provenancePath = path.join(repoDir, "ASSET_PROVENANCE.md");
    await mkdir(tasksDir, { recursive: true });

    await git(["init", "-q"], repoDir);
    await git(["config", "user.email", "test@example.com"], repoDir);
    await git(["config", "user.name", "Test"], repoDir);

    // No tasks/*.md at all -- reproduces CI's fs-mode reality where every db-mode card (T-0223+)
    // is invisible to the live store, so every id in this suite can only resolve via the ledger.
    await writeFile(provenancePath, "| base.png (no id here) | MIT | ... |\n");
    await git(["add", "-A"], repoDir);
    await git(["commit", "-q", "-m", "base"], repoDir);
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    baseRef = stdout.trim();
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  async function writeLedger(name, ledger) {
    const p = path.join(repoDir, name);
    await writeFile(p, JSON.stringify(ledger));
    return p;
  }

  async function addProvenanceLine(line) {
    const current = await execFileAsync("git", ["show", `HEAD:${path.basename(provenancePath)}`], { cwd: repoDir });
    await writeFile(provenancePath, current.stdout + line + "\n");
    await git(["add", "-A"], repoDir);
    await git(["commit", "-q", "-m", `add row: ${line}`], repoDir);
  }

  async function resetToBase() {
    await git(["reset", "-q", "--hard", baseRef], repoDir);
  }

  // T-0313: these three tests are about the ledger-*resolution* mechanism (#315), not staleness --
  // a fixed, ever-receding hardcoded date would eventually cross the new hours-scale freshness
  // threshold and start failing for a reason unrelated to what each test actually checks. Freshly
  // stamped `now()` keeps them independent of the staleness gate, which has its own dedicated
  // tests below.
  function freshTimestamp() {
    return new Date().toISOString();
  }

  it("resolves a db-mode-only id via the ledger and passes -- the #315 fix, end-to-end", async () => {
    const ledgerPath = await writeLedger("ledger-a.json", {
      version: 1,
      generated_at: freshTimestamp(),
      cards: [{ id: "T-9001", requires_approval: true, approved_by: "Anonymous", approved_at: "2026-09-01T00:00:00.000Z" }]
    });
    await addProvenanceLine("| new_asset.png (T-9001 -- APPROVED) | MIT | ... |");

    const result = await runScript({ cwd: repoDir, provenancePath, baseRef, env: { BOARD_APPROVAL_LEDGER: ledgerPath } });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("passed");
    expect(result.stdout).toContain("ledger supplied");
    await resetToBase();
  });

  it("still reports unverifiable-approval-claim when the ledger does not resolve the id either", async () => {
    const ledgerPath = await writeLedger("ledger-b.json", {
      version: 1,
      generated_at: freshTimestamp(),
      cards: [{ id: "T-0001", requires_approval: false, approved_by: null, approved_at: null }]
    });
    await addProvenanceLine("| unknown.png (T-9002 -- APPROVED) | MIT | ... |");

    const result = await runScript({ cwd: repoDir, provenancePath, baseRef, env: { BOARD_APPROVAL_LEDGER: ledgerPath } });

    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain("T-9002");
    expect(result.stdout + result.stderr).toContain("unverifiable-approval-claim");
    await resetToBase();
  });

  it(
    "still catches real drift resolved through the ledger -- the fallback does not defang the gate, and " +
      "the FAILED refusal names the ledger's path, generated_at, and age even when it is fresh, not stale " +
      "(T-0313 run-1 review: the ordinary drift-refusal path printed none of that, forcing a reader to " +
      "re-derive a snapshot's age from a bare timestamp by hand)",
    async () => {
      const generatedAt = freshTimestamp();
      const ledgerPath = await writeLedger("ledger-c.json", {
        version: 1,
        generated_at: generatedAt,
        cards: [{ id: "T-9003", requires_approval: true, approved_by: null, approved_at: null }]
      });
      await addProvenanceLine("| unapproved_but_claimed.png (T-9003 -- APPROVED) | MIT | ... |");

      const result = await runScript({ cwd: repoDir, provenancePath, baseRef, env: { BOARD_APPROVAL_LEDGER: ledgerPath } });

      expect(result.code).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain("T-9003");
      expect(output).toContain("unsubstantiated-approved-claim");
      expect(output).toContain(ledgerPath);
      expect(output).toContain(generatedAt);
      expect(output).toMatch(/\d+(\.\d+)?h old/);
      await resetToBase();
    }
  );

  it("reports a missing ledger file distinctly, and still fails closed rather than passing", async () => {
    const missingPath = path.join(repoDir, "does-not-exist.json");
    await addProvenanceLine("| unknown.png (T-9004 -- APPROVED) | MIT | ... |");

    const result = await runScript({ cwd: repoDir, provenancePath, baseRef, env: { BOARD_APPROVAL_LEDGER: missingPath } });

    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain("approval ledger not found");
    expect(result.stdout + result.stderr).toContain("unverifiable-approval-claim");
    await resetToBase();
  });

  it(
    "FAILS on a stale ledger that is load-bearing -- the exact T-0273 shape (a snapshot recording " +
      "unapproved while a real approval landed hours later) that cost five T-0274 runs, T-0306, and " +
      "develop red since #345",
    async () => {
      const ledgerPath = await writeLedger("ledger-e.json", {
        version: 1,
        generated_at: "2020-01-01T00:00:00.000Z",
        cards: [{ id: "T-9005", requires_approval: true, approved_by: "Anonymous", approved_at: "2020-01-01T00:00:00.000Z" }]
      });
      await addProvenanceLine("| stale_but_resolvable.png (T-9005 -- APPROVED) | MIT | ... |");

      const result = await runScript({ cwd: repoDir, provenancePath, baseRef, env: { BOARD_APPROVAL_LEDGER: ledgerPath } });

      expect(result.code).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain(ledgerPath);
      expect(output).toContain("2020-01-01T00:00:00.000Z");
      expect(output).toMatch(/stale/i);
      expect(output).toMatch(/load-bearing/i);
      await resetToBase();
    }
  );

  it("still PASSES on a stale, empty ledger -- staleness alone is not an error when nothing was supplied", async () => {
    // An ancient ledger with zero cards can never fill a gap the live store couldn't resolve on
    // its own -- filledFromLedger is always 0 here, so staleness alone must not fail the gate.
    const ledgerPath = await writeLedger("ledger-f.json", {
      version: 1,
      generated_at: "2020-01-01T00:00:00.000Z",
      cards: []
    });
    await addProvenanceLine("| unrelated.png (no id here, nothing to resolve) | MIT | ... |");

    const result = await runScript({ cwd: repoDir, provenancePath, baseRef, env: { BOARD_APPROVAL_LEDGER: ledgerPath } });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("passed");
    await resetToBase();
  });
});
