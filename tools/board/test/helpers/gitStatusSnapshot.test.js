import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { rmTemp } from "./rmTemp.js";
import { captureGitStatus, diffGitStatus } from "./gitStatusSnapshot.js";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

let repoRoot;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "board-git-status-snapshot-"));
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "test@example.com"], repoRoot);
  await git(["config", "user.name", "Test"], repoRoot);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"], repoRoot);
  await git(["commit", "-m", "initial"], repoRoot);
});

afterEach(async () => {
  await rmTemp(repoRoot);
});

describe("captureGitStatus", () => {
  it("returns an empty set for a clean working tree", async () => {
    const status = await captureGitStatus(repoRoot);
    expect(status.size).toBe(0);
  });

  it("captures a modified-but-uncommitted file", async () => {
    await fs.writeFile(path.join(repoRoot, "README.md"), "changed\n", "utf8");

    const status = await captureGitStatus(repoRoot);

    expect([...status]).toEqual([" M README.md"]);
  });

  it("captures a staged (added) file", async () => {
    await fs.writeFile(path.join(repoRoot, "new.md"), "new\n", "utf8");
    await git(["add", "new.md"], repoRoot);

    const status = await captureGitStatus(repoRoot);

    expect([...status]).toEqual(["A  new.md"]);
  });
});

describe("diffGitStatus", () => {
  it("reports nothing new when before and after are identical", () => {
    const before = new Set([" M pre-existing.md"]);
    const after = new Set([" M pre-existing.md"]);

    expect(diffGitStatus(before, after)).toEqual([]);
  });

  it("reports a line that appears after but was not present before", () => {
    const before = new Set([]);
    const after = new Set(["A  tasks/T-0155.md"]);

    expect(diffGitStatus(before, after)).toEqual(["A  tasks/T-0155.md"]);
  });

  it("does not re-report pre-existing dirty state that was already there before the run", () => {
    const before = new Set([" M already-dirty-before-suite.md"]);
    const after = new Set([" M already-dirty-before-suite.md", "A  tasks/T-0213.md"]);

    expect(diffGitStatus(before, after)).toEqual(["A  tasks/T-0213.md"]);
  });

  it("end-to-end: a real staged write to the fixture repo is detected as newly dirty", async () => {
    const before = await captureGitStatus(repoRoot);

    await fs.writeFile(path.join(repoRoot, "tasks-T-0155.md"), "polluted\n", "utf8");
    await git(["add", "tasks-T-0155.md"], repoRoot);

    const after = await captureGitStatus(repoRoot);

    expect(diffGitStatus(before, after)).toEqual(["A  tasks-T-0155.md"]);
  });
});
