import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectAddedLines } from "../src/lib/gitAddedLines.js";

const execFileAsync = promisify(execFile);

/**
 * `collectAddedLines` (T-0286): the diff-scoping primitive `checkApprovalProvenanceDrift.js`
 * needs so its loud unresolvable-reference check only ever fires on rows the current PR actually
 * introduces, never on the ~200 pre-existing `ASSET_PROVENANCE.md` rows a full-file scan would
 * otherwise catch on every unrelated future PR (see `approvalProvenanceDrift.js`'s `newLines`
 * docstring). A real git repo, not a mock -- this is a thin wrapper over `git diff`, and the
 * point is proving it parses real `git diff` output correctly.
 */
async function git(args, cwd) {
  await execFileAsync("git", args, { cwd });
}

describe("collectAddedLines", () => {
  let repoDir;
  let baseRef;

  beforeAll(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "board-added-lines-"));
    await git(["init", "-q"], repoDir);
    await git(["config", "user.email", "test@example.com"], repoDir);
    await git(["config", "user.name", "Test"], repoDir);

    await writeFile(path.join(repoDir, "NOTES.md"), "line one\nline two\n");
    await git(["add", "-A"], repoDir);
    await git(["commit", "-q", "-m", "base"], repoDir);
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    baseRef = stdout.trim();

    await writeFile(path.join(repoDir, "NOTES.md"), "line one\nline two\nline three\nline four\n");
    await git(["commit", "-q", "-am", "add lines"], repoDir);
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("returns exactly the newly-added lines (trimmed), never lines already present at baseRef", async () => {
    const added = await collectAddedLines({ cwd: repoDir, baseRef, file: "NOTES.md" });

    expect(added).toEqual(new Set(["line three", "line four"]));
  });

  it("returns an empty set when the file is unchanged between baseRef and HEAD", async () => {
    const added = await collectAddedLines({ cwd: repoDir, baseRef: "HEAD", file: "NOTES.md" });

    expect(added).toEqual(new Set());
  });

  it("returns null (cannot scope) when baseRef does not exist, rather than throwing", async () => {
    const added = await collectAddedLines({ cwd: repoDir, baseRef: "not-a-real-ref", file: "NOTES.md" });

    expect(added).toBeNull();
  });
});
