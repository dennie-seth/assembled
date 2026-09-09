import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readVerdictEntries } from "../src/lib/verdictArchive.js";
import { rmTemp } from "./helpers/rmTemp.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "migrateVerdictArchive.js");

async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [SCRIPT, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const FRONTMATTER = (id) =>
  `---\n` +
  `id: "${id}"\n` +
  `title: "Walk-cycle sheet generation"\n` +
  `status: "blocked"\n` +
  `priority: "P1"\n` +
  `phase: 5\n` +
  `agent: "assets"\n` +
  `depends_on: []\n` +
  `created: "2026-08-01"\n` +
  `branch: null\n` +
  `commit: null\n` +
  `pr: null\n` +
  `deliverable_type: "code"\n` +
  `requires_approval: false\n` +
  `approved_by: null\n` +
  `approved_at: null\n` +
  `attempts: 0\n` +
  `comments: []\n` +
  `attachments: []\n` +
  `---\n`;

/** Reconstructs T-0259's reported ~270 KB scale: dozens of Validation: FAIL rounds re-diagnosing one issue. */
function bigRealisticBody(rounds = 100) {
  const boilerplate =
    "pytest 123/123 green, ruff clean, TDD ordering confirmed, Co-authored-by trailer present, " +
    "no free-text UGC surface introduced, branch naming follows git-flow, home-palette indexed PNG " +
    "export checked against ASSET_PROVENANCE.md. ";
  let body =
    "## Context\nWalk-cycle sheet generation, two-tier master-sheet + composited-motion approach.\n\n" +
    "## Acceptance\n- [ ] sheet generated\n\n";
  for (let i = 1; i <= rounds; i += 1) {
    const text =
      `Reviewer round ${i}: ${boilerplate.repeat(12)}Blocking issue: ComfyUI's ImageQuantize node still ` +
      `samples palette colors from the source image rather than the fixed home palette.\n\n(run ${((i - 1) % 5) + 1} of 5)`;
    const timestamp = `2026-08-${String((i % 27) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`;
    body += `## Validation: FAIL (${timestamp})\n\n${text}\n\n`;
  }
  body += "## Validation: PASS (2026-08-28T12:00:00.000Z)\n\nfixed via T-0266's chunked/resumable generator.\n";
  return body;
}

let tmpDir;
let tasksDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-verdict-migrate-cli-"));
  tasksDir = path.join(tmpDir, "tasks");
  await fs.mkdir(tasksDir, { recursive: true });
});

afterEach(async () => {
  await rmTemp(tmpDir);
});

describe("migrateVerdictArchive.js CLI", () => {
  it("migrates a T-0259-scale (~270 KB) card, archives its Validation history, and reports before/after bytes", async () => {
    const body = bigRealisticBody(100);
    const filePath = path.join(tasksDir, "T-0259.md");
    await fs.writeFile(filePath, FRONTMATTER("T-0259") + body, "utf8");
    const beforeFileBytes = Buffer.byteLength(FRONTMATTER("T-0259") + body, "utf8");
    expect(beforeFileBytes).toBeGreaterThan(200_000);

    const result = await run(["T-0259", "--tasks-dir", tasksDir]);
    expect(result.code).toBe(0);

    const summary = JSON.parse(result.stdout.trim().split("\n").pop());
    expect(summary.id).toBe("T-0259");
    expect(summary.beforeBytes).toBe(beforeFileBytes);
    expect(summary.afterBytes).toBeLessThan(summary.beforeBytes * 0.05);
    expect(summary.archivedCount).toBe(101);

    const migrated = await fs.readFile(filePath, "utf8");
    expect(migrated).toContain("## Context");
    expect(migrated).not.toContain("Validation:");

    const entries = await readVerdictEntries(tasksDir, "T-0259");
    expect(entries).toHaveLength(101);
    expect(entries[0].text).toContain("Reviewer round 1:");
    expect(entries[100].text).toContain("fixed via T-0266");
  });

  it("migrates every card under --tasks-dir when no ids are given", async () => {
    await fs.writeFile(
      path.join(tasksDir, "T-0001.md"),
      FRONTMATTER("T-0001") + "## Context\nSmall card.\n\n## Validation: FAIL (t1)\n\nsome issue\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(tasksDir, "T-0002.md"),
      FRONTMATTER("T-0002") + "## Context\nNo validation history yet.\n",
      "utf8"
    );

    const result = await run(["--tasks-dir", tasksDir]);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const ids = lines.map((l) => l.id).sort();
    expect(ids).toEqual(["T-0001", "T-0002"]);

    const t1 = lines.find((l) => l.id === "T-0001");
    expect(t1.archivedCount).toBe(1);
    const t2 = lines.find((l) => l.id === "T-0002");
    expect(t2.archivedCount).toBe(0);
  });

  it("is safe to run twice -- a re-run archives nothing further and leaves the file unchanged", async () => {
    await fs.writeFile(
      path.join(tasksDir, "T-0001.md"),
      FRONTMATTER("T-0001") + "## Context\nSmall card.\n\n## Validation: FAIL (t1)\n\nsome issue\n",
      "utf8"
    );

    await run(["T-0001", "--tasks-dir", tasksDir]);
    const afterFirst = await fs.readFile(path.join(tasksDir, "T-0001.md"), "utf8");

    const result = await run(["T-0001", "--tasks-dir", tasksDir]);
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout.trim());
    expect(summary.archivedCount).toBe(0);

    const afterSecond = await fs.readFile(path.join(tasksDir, "T-0001.md"), "utf8");
    expect(afterSecond).toBe(afterFirst);

    const entries = await readVerdictEntries(tasksDir, "T-0001");
    expect(entries).toHaveLength(1);
  });
});
