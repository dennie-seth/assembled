import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { getCurrentBranch, getHeadInfo, getGitStatus } from "../src/lib/gitInfo.js";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

let tmpDir;
let repoRoot;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-gitinfo-"));
  repoRoot = path.join(tmpDir, "repo");
  await fs.mkdir(repoRoot, { recursive: true });
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "test@example.com"], repoRoot);
  await git(["config", "user.name", "Test"], repoRoot);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"], repoRoot);
  await git(["commit", "-m", "initial"], repoRoot);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("getCurrentBranch", () => {
  it("returns the current branch name", async () => {
    const branch = await getCurrentBranch(repoRoot);
    expect(branch).toBe("main");
  });

  it("reflects a checkout to a new branch", async () => {
    await git(["checkout", "-b", "feature/test"], repoRoot);
    const branch = await getCurrentBranch(repoRoot);
    expect(branch).toBe("feature/test");
  });
});

describe("getHeadInfo", () => {
  it("returns a 40-char sha and an ISO timestamp", async () => {
    const { sha, isoDate } = await getHeadInfo(repoRoot);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(isoDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("sha matches git rev-parse HEAD", async () => {
    const { sha } = await getHeadInfo(repoRoot);
    const { stdout } = await git(["rev-parse", "HEAD"], repoRoot);
    expect(sha).toBe(stdout.trim());
  });

  it("sha changes after a new commit", async () => {
    const before = await getHeadInfo(repoRoot);
    await fs.writeFile(path.join(repoRoot, "new.txt"), "x\n", "utf8");
    await git(["add", "new.txt"], repoRoot);
    await git(["commit", "-m", "second"], repoRoot);
    const after = await getHeadInfo(repoRoot);
    expect(after.sha).not.toBe(before.sha);
  });
});

describe("getGitStatus", () => {
  it("returns branch, head sha, and headTimestamp", async () => {
    const status = await getGitStatus(repoRoot);
    expect(status.branch).toBe("main");
    expect(status.head).toMatch(/^[0-9a-f]{40}$/);
    expect(status.headTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("branch reflects a checkout to a feature branch", async () => {
    await git(["checkout", "-b", "feature/T-0116"], repoRoot);
    const status = await getGitStatus(repoRoot);
    expect(status.branch).toBe("feature/T-0116");
  });
});
