import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts/countCommittedAssets.js"
);

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

async function writeFile(root, relPath, contents) {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, "utf8");
}

let tmpDir;
let repoRoot;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-count-committed-cli-"));
  repoRoot = path.join(tmpDir, "repo");
  await fs.mkdir(repoRoot, { recursive: true });
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "test@example.com"], repoRoot);
  await git(["config", "user.name", "Test"], repoRoot);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("scripts/countCommittedAssets.js", () => {
  it("prints a JSON object with the committed asset count for a card", async () => {
    await writeFile(repoRoot, "assets/final/character/idle.png", "png-bytes");
    await writeFile(
      repoRoot,
      "assets/final/character/idle.provenance.json",
      JSON.stringify({ card: "T-0252" })
    );
    await git(["add", "."], repoRoot);
    await git(["commit", "-m", "add asset"], repoRoot);

    const { stdout } = await execFileAsync("node", [
      SCRIPT_PATH,
      "T-0252",
      "--repo-root",
      repoRoot,
      "--ref",
      "HEAD"
    ]);

    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({
      cardId: "T-0252",
      ref: "HEAD",
      count: 1,
      files: ["assets/final/character/idle.png"]
    });
  });

  it("prints count: 0 for a card with nothing committed under assets/final/", async () => {
    await writeFile(repoRoot, "README.md", "nothing shipped");
    await git(["add", "."], repoRoot);
    await git(["commit", "-m", "init"], repoRoot);

    const { stdout } = await execFileAsync("node", [
      SCRIPT_PATH,
      "T-0315",
      "--repo-root",
      repoRoot,
      "--ref",
      "HEAD"
    ]);

    const parsed = JSON.parse(stdout);
    expect(parsed.count).toBe(0);
    expect(parsed.files).toEqual([]);
  });

  it("exits non-zero with a usage message when no card id is given", async () => {
    await expect(
      execFileAsync("node", [SCRIPT_PATH, "--repo-root", repoRoot])
    ).rejects.toMatchObject({ code: 1 });
  });
});
