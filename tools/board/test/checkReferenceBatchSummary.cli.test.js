import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "checkReferenceBatchSummary.js");

const COMPLIANT = [
  "# T-9999 reference sourcing — test pose (for T-0000)",
  "",
  "| File (sha256 prefix) | Title | Source | Asset ID | Source URL | Licence | Retrieved | Verdict |",
  "|---|---|---|---|---|---|---|---|",
  "| `abc123...` | a title | openverse | `asset-1` | https://api.openverse.org/v1/images/asset-1/thumb/ | cc0 | 2026-09-01T17:16:17.577Z | **KEPT** — clean |"
].join("\n");

// Reproduces the exact T-0281 shape this card exists to catch: sha256/title/licence/retrievedAt
// recorded, but no Asset ID or Source URL column at all.
const NON_COMPLIANT = [
  "# T-9999 reference sourcing — test pose (for T-0000)",
  "",
  "| File (sha256 prefix) | Title | Source | Licence | Retrieved | Verdict |",
  "|---|---|---|---|---|---|",
  "| `abc123...` | a title | openverse | cc0 | 2026-09-01T17:16:17.577Z | **KEPT** — clean |"
].join("\n");

let tmpDir;

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

async function writeFixture(name, content) {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-check-ref-summary-"));
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [SCRIPT, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("checkReferenceBatchSummary.js CLI -- mechanical enforcement of assetId/sourceUrl per kept image", () => {
  it("refuses with usage when no file argument is given", async () => {
    const result = await run([]);
    expect(result.code).toBe(64);
    expect(result.stderr).toMatch(/usage/i);
  });

  it("exits 0 for a summary whose kept row records Asset ID and Source URL", async () => {
    const filePath = await writeFixture("compliant-summary.md", COMPLIANT);
    const result = await run([filePath]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/ok/i);
  });

  it("exits non-zero for a summary whose kept row is missing Asset ID and Source URL columns (the T-0281 shape)", async () => {
    const filePath = await writeFixture("non-compliant-summary.md", NON_COMPLIANT);
    const result = await run([filePath]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Asset ID/);
    expect(result.stderr).toMatch(/Source URL/);
  });

  it("checks every path given and fails overall if any one of them fails", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-check-ref-summary-"));
    const goodPath = path.join(tmpDir, "good.md");
    const badPath = path.join(tmpDir, "bad.md");
    await fs.writeFile(goodPath, COMPLIANT, "utf8");
    await fs.writeFile(badPath, NON_COMPLIANT, "utf8");
    const result = await run([goodPath, badPath]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toMatch(/good\.md.*ok/is);
    expect(result.stderr).toMatch(/bad\.md/);
  });
});
