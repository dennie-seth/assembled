import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { rmTemp } from "../helpers/rmTemp.js";
import { createGuard } from "./workingTreeGuard.js";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

let repoRoot;
let originalExitCode;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "board-working-tree-guard-"));
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "test@example.com"], repoRoot);
  await git(["config", "user.name", "Test"], repoRoot);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"], repoRoot);
  await git(["commit", "-m", "initial"], repoRoot);
  originalExitCode = process.exitCode;
});

afterEach(async () => {
  process.exitCode = originalExitCode;
  await rmTemp(repoRoot);
});

/**
 * T-0302 review finding: the teardown used to only `throw`, which Vitest 4.1's
 * `Vitest.close()` swallows into a logged `teardownErrors` array without ever touching
 * `process.exitCode` -- so a leak into the real repo still reported "N passed" and exited 0.
 * These test the actual wiring (does calling the exported teardown set a nonzero exit code?),
 * not just that the underlying diff helper computes the right lines (see
 * helpers/gitStatusSnapshot.test.js for that).
 */
describe("workingTreeGuard", () => {
  it("does not throw or touch the exit code when the tree is clean at teardown", async () => {
    const setup = createGuard(repoRoot);
    const teardown = await setup();

    await expect(teardown()).resolves.toBeUndefined();

    expect(process.exitCode).toBe(originalExitCode);
  });

  it("throws AND sets a nonzero exit code when a test leaves the tree dirtier than before", async () => {
    const setup = createGuard(repoRoot);
    const teardown = await setup();

    await fs.writeFile(path.join(repoRoot, "tasks-T-9999.md"), "polluted\n", "utf8");
    await git(["add", "tasks-T-9999.md"], repoRoot);

    await expect(teardown()).rejects.toThrow(/dirtier than before/);

    expect(process.exitCode).toBe(1);
  });
});
