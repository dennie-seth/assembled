import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./helpers/rmTemp.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "promoteEvidence.js");

async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [SCRIPT, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

async function writeFile(root, rel, contents) {
  const target = path.join(root, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
  return target;
}

let tmpDir;
let repoRoot;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-evidence-cli-"));
  repoRoot = path.join(tmpDir, "repo");
  await fs.mkdir(repoRoot, { recursive: true });
});

afterEach(async () => {
  await rmTemp(tmpDir);
});

describe("promoteEvidence.js CLI", () => {
  it("refuses with usage when required arguments are missing", async () => {
    const result = await run([]);
    expect(result.code).toBe(64);
    expect(result.stderr).toMatch(/usage/i);
  });

  it("promotes cited frames and prints a JSON summary, given a real card run + log", async () => {
    await writeFile(repoRoot, "assets/out/hybrid_profile/attempt_14/main_384.png", "frame-14");
    await writeFile(
      repoRoot,
      "assets/src/character/ARM_HYBRID_ATTEMPT_LOG_T9999.md",
      "The decisive frame is `attempt_14/main_384.png`."
    );

    const result = await run([
      "T-9999",
      "assets/out/hybrid_profile",
      "assets/src/character/ARM_HYBRID_ATTEMPT_LOG_T9999.md",
      "--repo-root",
      repoRoot
    ]);

    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.promoted).toEqual([
      { cited: "attempt_14/main_384.png", destRelPath: "docs/assets/evidence/T-9999/attempt_14_main_384.png", bytes: 8 }
    ]);
    const committed = await fs.readFile(path.join(repoRoot, "docs/assets/evidence/T-9999/attempt_14_main_384.png"));
    expect(committed.toString()).toBe("frame-14");
  });

  it("exits 0 and promotes nothing for a run that crashed before generating anything", async () => {
    await writeFile(
      repoRoot,
      "assets/src/character/ARM_HYBRID_ATTEMPT_LOG_T9999.md",
      "The decisive frame is `attempt_1/main_384.png`."
    );

    const result = await run([
      "T-9999",
      "assets/out/hybrid_profile",
      "assets/src/character/ARM_HYBRID_ATTEMPT_LOG_T9999.md",
      "--repo-root",
      repoRoot
    ]);

    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.promoted).toEqual([]);
    expect(summary.skippedMissing).toEqual(["attempt_1/main_384.png"]);
  });
});
