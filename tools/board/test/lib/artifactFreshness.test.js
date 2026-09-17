import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { checkArtifactFreshness, defaultListCommitsSince } from "../../src/lib/artifactFreshness.js";
import { formatHostActionRequest } from "../../src/lib/hostActionRequest.js";

function task(overrides = {}) {
  return { id: "T-0351", ...overrides };
}

/**
 * T-0354: existence (T-0352's own gate) proves a claimed deliverable path is a real, committed
 * file -- it says nothing about *when* that file was committed. The T-0351 incident this card is
 * named for is exactly that gap: a previously-promoted master sheet already satisfied the
 * existence check while three consecutive runs extended generator code, went green, and committed
 * without ever invoking the model. `checkArtifactFreshness` is the freshness half: given the
 * repo-relative path(s) an existence check already verified, it fails unless at least one of them
 * was actually touched by a commit made since this run's own start.
 */
describe("checkArtifactFreshness", () => {
  it("is not applicable when runStartTime is missing (caller has no boundary to check freshness against)", async () => {
    const report = await checkArtifactFreshness({
      task: task(),
      verifiedPaths: ["assets/final/character/t0351_master_sheet.png"],
      repoRoot: "/repo"
    });
    expect(report).toEqual({ ok: true, applicable: false, errors: [] });
  });

  it("is not applicable when repoRoot is missing", async () => {
    const report = await checkArtifactFreshness({
      task: task(),
      verifiedPaths: ["assets/final/character/t0351_master_sheet.png"],
      runStartTime: "2026-09-10T00:00:00Z"
    });
    expect(report.applicable).toBe(false);
  });

  it("is not applicable when there are no verified paths to check freshness of", async () => {
    const report = await checkArtifactFreshness({
      task: task(),
      verifiedPaths: [],
      runStartTime: "2026-09-10T00:00:00Z",
      repoRoot: "/repo"
    });
    expect(report.applicable).toBe(false);
  });

  it("FAILs when no commit since runStartTime touches any verified path -- a pre-existing artifact does not prove this run invoked the model", async () => {
    const report = await checkArtifactFreshness({
      task: task(),
      verifiedPaths: ["assets/final/character/t0351_master_sheet.png"],
      runStartTime: "2026-09-10T12:00:00Z",
      repoRoot: "/repo",
      listCommitsSince: async () => [
        { sha: "aaa", message: "feat: T-0351 extend generator", changedPaths: ["assets/src/character/gen.py"] },
        { sha: "bbb", message: "test: T-0351 GREEN", changedPaths: ["assets/src/character/tests/test_gen.py"] }
      ]
    });
    expect(report.applicable).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toMatch(/t0351_master_sheet\.png/);
    expect(report.errors.join(" ")).toMatch(/run started|since this run/i);
  });

  it("the exact T-0351 regression shape: two commits nine seconds apart touching only .py files, zero image commits -- FAILs", async () => {
    const report = await checkArtifactFreshness({
      task: task(),
      verifiedPaths: ["assets/final/character/t0351_master_sheet.png"],
      runStartTime: "2026-09-10T12:00:00Z",
      repoRoot: "/repo",
      listCommitsSince: async () => [
        {
          sha: "c1",
          message: "feat: T-0351 Tier-1 master sheet REGEN in limb-separating poses",
          changedPaths: [
            "assets/src/character/gen_master_sheet.py",
            "assets/src/character/poses.py",
            "assets/src/character/conftest.py",
            "assets/src/character/tests/test_master_sheet.py"
          ]
        },
        {
          sha: "c2",
          message: "docs: T-0351 -- RE-SCOPE attempts 19-21 evidence",
          changedPaths: ["docs/assets/evidence/T-0351/README.md"]
        }
      ]
    });
    expect(report.ok).toBe(false);
  });

  it("FAILs when there are no commits at all since runStartTime (nothing committed this run)", async () => {
    const report = await checkArtifactFreshness({
      task: task(),
      verifiedPaths: ["assets/final/character/t0351_master_sheet.png"],
      runStartTime: "2026-09-10T12:00:00Z",
      repoRoot: "/repo",
      listCommitsSince: async () => []
    });
    expect(report.ok).toBe(false);
  });

  it("PASSes when a commit since runStartTime touches one of the verified paths -- the model actually ran this time", async () => {
    const report = await checkArtifactFreshness({
      task: task(),
      verifiedPaths: ["assets/final/character/t0351_master_sheet.png"],
      runStartTime: "2026-09-10T12:00:00Z",
      repoRoot: "/repo",
      listCommitsSince: async () => [
        {
          sha: "c1",
          message: "feat: T-0351 regenerate master sheet",
          changedPaths: ["assets/final/character/t0351_master_sheet.png"]
        }
      ]
    });
    expect(report).toEqual({ ok: true, applicable: true, errors: [] });
  });

  it("PASSes when ANY one of several verified paths was freshly touched, not all of them", async () => {
    const report = await checkArtifactFreshness({
      task: task(),
      verifiedPaths: ["assets/final/pose-set/idle.png", "assets/final/pose-set/walk.png"],
      runStartTime: "2026-09-10T12:00:00Z",
      repoRoot: "/repo",
      listCommitsSince: async () => [
        { sha: "c1", message: "feat: regen walk", changedPaths: ["assets/final/pose-set/walk.png"] }
      ]
    });
    expect(report.ok).toBe(true);
  });

  it("is distinguishable and NOT punished when this run's commits carry a genuine host-action-request block -- a real host outage, not 'never tried'", async () => {
    const hostActionBlock = formatHostActionRequest({
      host: "Windows ComfyUI host (F:\\ComfyUI)",
      action: "restart the ComfyUI service, it is not responding on 172.18.192.1:8188",
      reason: "no shell on the host from this WSL2 worktree",
      verify: "curl http://172.18.192.1:8188/system_stats returns 200"
    });
    const report = await checkArtifactFreshness({
      task: task(),
      verifiedPaths: ["assets/final/character/t0351_master_sheet.png"],
      runStartTime: "2026-09-10T12:00:00Z",
      repoRoot: "/repo",
      listCommitsSince: async () => [
        { sha: "c1", message: `docs: T-0351 host outage\n\n${hostActionBlock}`, changedPaths: ["tasks/T-0351.md"] }
      ]
    });
    expect(report).toEqual({ ok: true, applicable: true, errors: [] });
  });

  it("does NOT exempt on an incomplete host-action mention -- only a well-formed, complete block counts (matches hostActionRequest.js's own strictness)", async () => {
    const report = await checkArtifactFreshness({
      task: task(),
      verifiedPaths: ["assets/final/character/t0351_master_sheet.png"],
      runStartTime: "2026-09-10T12:00:00Z",
      repoRoot: "/repo",
      listCommitsSince: async () => [
        { sha: "c1", message: "the host was down, sorry", changedPaths: ["assets/src/character/gen.py"] }
      ]
    });
    expect(report.ok).toBe(false);
  });
});

describe("defaultListCommitsSince (real git)", () => {
  let dir;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns commits made since the given timestamp, each with its changed paths and full message", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-freshness-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });

    await fs.writeFile(path.join(dir, "old.png"), "old bytes");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "old commit, before the run"], { cwd: dir });

    // Anchor "run start" strictly after the commit above and strictly before the one below --
    // `git log --since` is second-resolution, so a 2-second gap avoids clock-skew flakiness.
    const runStartTime = new Date(Date.now() + 2000).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 2200));

    await fs.writeFile(path.join(dir, "gen.py"), "print('hi')");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "feat: extend generator"], { cwd: dir });

    const commits = await defaultListCommitsSince(dir, runStartTime);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toContain("feat: extend generator");
    expect(commits[0].changedPaths).toEqual(["gen.py"]);
  });

  it("returns an empty array for a non-git directory rather than throwing (fail closed, same convention as defaultListCommittedBlobs)", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-freshness-notgit-"));
    const commits = await defaultListCommitsSince(dir, new Date().toISOString());
    expect(commits).toEqual([]);
  });
});
