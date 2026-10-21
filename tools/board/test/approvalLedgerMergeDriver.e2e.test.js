import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./helpers/rmTemp.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DRIVER_SRC = path.join(REPO_ROOT, "tools/board/scripts/mergeApprovalLedgerDriver.js");
const MERGE_LIB_SRC = path.join(REPO_ROOT, "tools/board/src/lib/approvalLedgerMerge.js");
const INSTALL_SCRIPT_SRC = path.join(REPO_ROOT, "tools/board/ops/install-approval-ledger-merge-driver.sh");
const LEDGER_RELATIVE_PATH = "tools/board/approval-ledger.json";

/**
 * T-0464: proves the actual committed merge driver -- not a reimplementation of its logic --
 * resolves a two-sided merge of `tools/board/approval-ledger.json` without a text conflict, using
 * a real throwaway git repository on disk. This repository's merge-driver files are copied into
 * the fixture repo verbatim and wired up exactly the way a real clone would (via the committed
 * `.gitattributes` entry plus the committed install script, which is what has to run per-clone
 * because git merge drivers cannot be fully defined from a committed file alone -- see
 * docs/approval-ledger-merge-driver.md).
 */

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

function ledgerJson({ generatedAt, cards }) {
  return `${JSON.stringify({ version: 1, generated_at: generatedAt, cards }, null, 2)}\n`;
}

function card(id, overrides = {}) {
  return { id, requires_approval: false, approved_by: null, approved_at: null, ...overrides };
}

/** Builds a fresh fixture repo with the real driver/install-script files mirrored at their real relative paths. */
async function buildFixtureRepo({ installDriver }) {
  const repoDir = await mkdtemp(path.join(tmpdir(), "board-ledger-merge-e2e-"));

  await mkdir(path.join(repoDir, "tools/board/scripts"), { recursive: true });
  await mkdir(path.join(repoDir, "tools/board/src/lib"), { recursive: true });
  await mkdir(path.join(repoDir, "tools/board/ops"), { recursive: true });
  await copyFile(DRIVER_SRC, path.join(repoDir, "tools/board/scripts/mergeApprovalLedgerDriver.js"));
  await copyFile(MERGE_LIB_SRC, path.join(repoDir, "tools/board/src/lib/approvalLedgerMerge.js"));
  await copyFile(INSTALL_SCRIPT_SRC, path.join(repoDir, "tools/board/ops/install-approval-ledger-merge-driver.sh"));
  await chmod(path.join(repoDir, "tools/board/ops/install-approval-ledger-merge-driver.sh"), 0o755);

  await writeFile(path.join(repoDir, ".gitattributes"), `${LEDGER_RELATIVE_PATH} merge=approval-ledger\n`);

  await git(["init", "-q"], repoDir);
  await git(["config", "user.email", "test@example.com"], repoDir);
  await git(["config", "user.name", "Test"], repoDir);

  await writeFile(
    path.join(repoDir, LEDGER_RELATIVE_PATH),
    ledgerJson({ generatedAt: "2026-10-21T10:00:00.000Z", cards: [card("T-0001"), card("T-0002")] })
  );
  await git(["add", "-A"], repoDir);
  await git(["commit", "-q", "-m", "base"], repoDir);
  const baseBranch = (await git(["symbolic-ref", "--short", "HEAD"], repoDir)).stdout.trim();

  if (installDriver) {
    await execFileAsync("bash", ["tools/board/ops/install-approval-ledger-merge-driver.sh"], { cwd: repoDir });
  }

  // "ours": adds a brand-new card, bumps generated_at.
  await git(["checkout", "-q", "-b", "ours"], repoDir);
  await writeFile(
    path.join(repoDir, LEDGER_RELATIVE_PATH),
    ledgerJson({
      generatedAt: "2026-10-21T14:45:00.000Z",
      cards: [card("T-0001"), card("T-0002"), card("T-0010")]
    })
  );
  await git(["commit", "-aq", "-m", "ours: add T-0010"], repoDir);

  // "theirs": flips an existing card's requires_approval, different (earlier) generated_at.
  await git(["checkout", "-q", "-b", "theirs", baseBranch], repoDir);
  await writeFile(
    path.join(repoDir, LEDGER_RELATIVE_PATH),
    ledgerJson({
      generatedAt: "2026-10-21T12:00:00.000Z",
      cards: [
        card("T-0001", { requires_approval: true, approved_by: "Anonymous", approved_at: "2026-10-21T12:00:00.000Z" }),
        card("T-0002")
      ]
    })
  );
  await git(["commit", "-aq", "-m", "theirs: approve T-0001"], repoDir);

  await git(["checkout", "-q", "ours"], repoDir);

  return repoDir;
}

describe("approval-ledger merge driver (end-to-end, real git repo)", () => {
  let repoDir;

  afterEach(async () => {
    await rmTemp(repoDir);
    repoDir = undefined;
  });

  it("merges a two-sided ledger-only change with no conflict when the driver is installed", async () => {
    repoDir = await buildFixtureRepo({ installDriver: true });

    const mergeResult = await git(["merge", "--no-edit", "theirs"], repoDir).then(
      (res) => ({ code: 0, ...res }),
      (err) => ({ code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" })
    );

    expect(mergeResult.code).toBe(0);

    const status = await git(["status", "--porcelain"], repoDir);
    expect(status.stdout.trim()).toBe("");

    const mergedRaw = await readFile(path.join(repoDir, LEDGER_RELATIVE_PATH), "utf8");
    expect(mergedRaw).not.toContain("<<<<<<<");
    expect(mergedRaw).not.toContain("=======");
    expect(mergedRaw).not.toContain(">>>>>>>");

    const merged = JSON.parse(mergedRaw);
    expect(Array.isArray(merged.cards)).toBe(true);
    const ids = merged.cards.map((c) => c.id).sort();
    expect(ids).toEqual(["T-0001", "T-0002", "T-0010"]);

    const t0001 = merged.cards.find((c) => c.id === "T-0001");
    expect(t0001.requires_approval).toBe(true);
    expect(t0001.approved_by).toBe("Anonymous");
  });

  it("never hands back a generated_at older than the newer of the two sides", async () => {
    repoDir = await buildFixtureRepo({ installDriver: true });
    await git(["merge", "--no-edit", "theirs"], repoDir);

    const merged = JSON.parse(await readFile(path.join(repoDir, LEDGER_RELATIVE_PATH), "utf8"));

    // ours = 2026-10-21T14:45:00.000Z, theirs = 2026-10-21T12:00:00.000Z -- ours is newer.
    expect(Date.parse(merged.generated_at)).toBeGreaterThanOrEqual(Date.parse("2026-10-21T14:45:00.000Z"));
  });

  it("still reports a conflict (not a quiet result) when the local merge-driver config was never installed", async () => {
    repoDir = await buildFixtureRepo({ installDriver: false });

    const mergeResult = await git(["merge", "--no-edit", "theirs"], repoDir).then(
      (res) => ({ code: 0, ...res }),
      (err) => ({ code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" })
    );

    expect(mergeResult.code).not.toBe(0);

    const status = await git(["status", "--porcelain"], repoDir);
    expect(status.stdout).toContain("UU ");

    await git(["merge", "--abort"], repoDir);
  });
});
