import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  verdictArchivePath,
  appendVerdictEntry,
  readVerdictEntries,
  buildVerdictDigest,
  migrateBodyVerdicts,
  renderVerdictEntry
} from "../../src/lib/verdictArchive.js";
import { rmTemp } from "../helpers/rmTemp.js";

let tmpDir;
let tasksDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-verdict-archive-"));
  tasksDir = path.join(tmpDir, "tasks");
  await fs.mkdir(tasksDir, { recursive: true });
});

afterEach(async () => {
  await rmTemp(tmpDir);
});

describe("appendVerdictEntry / readVerdictEntries", () => {
  it("returns an empty array for a card with no archive yet", async () => {
    expect(await readVerdictEntries(tasksDir, "T-0001")).toEqual([]);
  });

  it("round-trips a single appended entry", async () => {
    await appendVerdictEntry(tasksDir, "T-0001", {
      heading: "Validation: FAIL",
      timestamp: "2026-08-01T00:00:00.000Z",
      text: "missing test"
    });
    const entries = await readVerdictEntries(tasksDir, "T-0001");
    expect(entries).toEqual([
      { heading: "Validation: FAIL", timestamp: "2026-08-01T00:00:00.000Z", text: "missing test" }
    ]);
  });

  it("appends in chronological order across multiple calls", async () => {
    await appendVerdictEntry(tasksDir, "T-0001", { heading: "Validation: FAIL", timestamp: "t1", text: "first" });
    await appendVerdictEntry(tasksDir, "T-0001", { heading: "Validation: PASS", timestamp: "t2", text: "second" });
    const entries = await readVerdictEntries(tasksDir, "T-0001");
    expect(entries.map((e) => e.text)).toEqual(["first", "second"]);
  });

  it("keeps different cards' archives independent", async () => {
    await appendVerdictEntry(tasksDir, "T-0001", { heading: "Validation: FAIL", timestamp: "t1", text: "card 1" });
    await appendVerdictEntry(tasksDir, "T-0002", { heading: "Validation: FAIL", timestamp: "t1", text: "card 2" });
    expect((await readVerdictEntries(tasksDir, "T-0001"))[0].text).toBe("card 1");
    expect((await readVerdictEntries(tasksDir, "T-0002"))[0].text).toBe("card 2");
  });

  it("stores the archive outside the task's own card file, under tasksDir", async () => {
    await appendVerdictEntry(tasksDir, "T-0001", { heading: "Validation: FAIL", timestamp: "t1", text: "x" });
    const archivePath = verdictArchivePath(tasksDir, "T-0001");
    expect(archivePath).not.toBe(path.join(tasksDir, "T-0001.md"));
    expect(archivePath.startsWith(tasksDir)).toBe(true);
    await expect(fs.access(archivePath)).resolves.toBeUndefined();
  });

  it("handles multi-paragraph verdict text (embedded blank lines) losslessly", async () => {
    const text = "First paragraph.\n\nSecond paragraph with detail.\n\n(run 2 of 5)";
    await appendVerdictEntry(tasksDir, "T-0001", { heading: "Validation: FAIL", timestamp: "t1", text });
    const entries = await readVerdictEntries(tasksDir, "T-0001");
    expect(entries[0].text).toBe(text);
  });
});

describe("renderVerdictEntry", () => {
  it("reconstructs the original body section format", () => {
    const entry = { heading: "Validation: FAIL", timestamp: "2026-08-01T00:00:00.000Z", text: "missing test" };
    expect(renderVerdictEntry(entry)).toBe("## Validation: FAIL (2026-08-01T00:00:00.000Z)\n\nmissing test\n");
  });

  it("round-trips through migrateBodyVerdicts: rendering every extracted entry back reproduces the original sections", () => {
    const body =
      "## Context\nSomething.\n\n" +
      "## Validation: FAIL (t1)\n\nfirst failure\n\n" +
      "## Validation: PASS (t2)\n\nfixed\n";
    const { entries } = migrateBodyVerdicts(body);
    const rendered = entries.map(renderVerdictEntry).join("\n");
    expect(rendered).toBe("## Validation: FAIL (t1)\n\nfirst failure\n\n## Validation: PASS (t2)\n\nfixed\n");
  });
});

describe("buildVerdictDigest", () => {
  it("returns an empty string for no entries", () => {
    expect(buildVerdictDigest([])).toBe("");
  });

  it("is a pure, deterministic function of its input", () => {
    const entries = [
      { heading: "Validation: FAIL", timestamp: "2026-08-01T00:00:00.000Z", text: "missing test at src/foo.js:12" },
      { heading: "Validation: PASS", timestamp: "2026-08-02T00:00:00.000Z", text: "all green" }
    ];
    expect(buildVerdictDigest(entries)).toBe(buildVerdictDigest(entries));
  });

  it("reports total FAIL/PASS counts", () => {
    const entries = [
      { heading: "Validation: FAIL", timestamp: "t1", text: "a" },
      { heading: "Validation: FAIL", timestamp: "t2", text: "b" },
      { heading: "Validation: PASS", timestamp: "t3", text: "c" }
    ];
    const digest = buildVerdictDigest(entries);
    expect(digest).toContain("3 prior validation verdict(s)");
    expect(digest).toContain("2 FAIL");
    expect(digest).toContain("1 PASS");
  });

  it("includes each recent entry's timestamp, heading and text", () => {
    const entries = [
      { heading: "Validation: FAIL", timestamp: "2026-08-01T00:00:00.000Z", text: "missing test at src/foo.js:12" }
    ];
    const digest = buildVerdictDigest(entries);
    expect(digest).toContain("2026-08-01T00:00:00.000Z");
    expect(digest).toContain("Validation: FAIL");
    expect(digest).toContain("missing test at src/foo.js:12");
  });

  it("truncates a very long verdict text rather than reproducing it in full", () => {
    const longText = "x".repeat(2000);
    const digest = buildVerdictDigest([{ heading: "Validation: FAIL", timestamp: "t1", text: longText }]);
    expect(digest.length).toBeLessThan(longText.length);
  });

  it("caps how many entries are rendered in detail, but still reports the true total count", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      heading: "Validation: FAIL",
      timestamp: `t${i}`,
      text: `round ${i}`
    }));
    const digest = buildVerdictDigest(entries, { limit: 5 });
    expect(digest).toContain("20 prior validation verdict(s)");
    expect(digest).toContain("round 19");
    expect(digest).not.toContain("round 0");
  });
});

describe("migrateBodyVerdicts", () => {
  it("returns the body unchanged and no entries when there is nothing to archive", () => {
    const body = "## Context\nDo the thing.\n\n## Acceptance\n- [ ] works\n";
    const result = migrateBodyVerdicts(body);
    expect(result.body).toBe(body);
    expect(result.entries).toEqual([]);
  });

  it("extracts a single Validation: FAIL section and strips it from the body", () => {
    const body =
      "## Context\nDo the thing.\n\n" +
      "## Validation: FAIL (2026-08-01T00:00:00.000Z)\n\nmissing test at src/foo.js:12\n\n(run 1 of 5)\n";
    const { body: newBody, entries } = migrateBodyVerdicts(body);
    expect(newBody).toContain("## Context");
    expect(newBody).not.toContain("Validation: FAIL");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ heading: "Validation: FAIL", timestamp: "2026-08-01T00:00:00.000Z" });
    expect(entries[0].text).toBe("missing test at src/foo.js:12\n\n(run 1 of 5)");
  });

  it("extracts multiple Validation sections in original order and leaves non-Validation sections (Context, PR) in place", () => {
    const body =
      "## Context\nDo the thing.\n\n" +
      "## Validation: FAIL (t1)\n\nfirst fail\n\n" +
      "## Validation: FAIL (t2)\n\nsecond fail\n\n" +
      "## Validation: PASS (t3)\n\nall good\n\n" +
      "## PR (t3)\n\nhttps://github.com/example/repo/pull/1\n";
    const { body: newBody, entries } = migrateBodyVerdicts(body);
    expect(entries.map((e) => e.text)).toEqual(["first fail", "second fail", "all good"]);
    expect(newBody).toContain("## Context");
    expect(newBody).toContain("## PR (t3)");
    expect(newBody).not.toContain("Validation:");
  });

  it("round-trips losslessly: heading + timestamp + text reproduce the original section byte-for-byte in the standard note shape", () => {
    const heading = "Validation: FAIL";
    const timestamp = "2026-08-01T00:00:00.000Z";
    const text = "missing test at src/foo.js:12\n\n(run 1 of 5)";
    const originalSection = `## ${heading} (${timestamp})\n\n${text}\n`;
    const body = `## Context\nOriginal.\n\n${originalSection}`;
    const { entries } = migrateBodyVerdicts(body);
    const reconstructed = `## ${entries[0].heading} (${entries[0].timestamp})\n\n${entries[0].text}\n`;
    expect(reconstructed).toBe(originalSection);
  });

  it("is idempotent -- migrating an already-migrated body a second time is a no-op", () => {
    const body = "## Context\nDo the thing.\n\n## Validation: FAIL (t1)\n\nfirst fail\n";
    const first = migrateBodyVerdicts(body);
    const second = migrateBodyVerdicts(first.body);
    expect(second.entries).toEqual([]);
    expect(second.body).toBe(first.body);
  });

  it("leaves an empty body untouched", () => {
    expect(migrateBodyVerdicts("")).toEqual({ body: "", entries: [] });
  });

  it("handles a large, realistic body modeling T-0259 (~270 KB, dozens of repeated Validation: FAIL rounds) without losing any round's text", () => {
    // T-0259's actual card file is per-deployment local state (tasks/ is gitignored except a
    // small allowlist), so it isn't present in this checkout -- this fixture reconstructs its
    // reported scale and shape instead: the same re-diagnosing-the-same-issue pattern the repo
    // has already seen play out on tasks/T-0129.md (12 rounds re-stating one ruff error).
    const rounds = 100;
    const boilerplate =
      "pytest 123/123 green, ruff clean, TDD ordering confirmed, Co-authored-by trailer present, " +
      "no free-text UGC surface introduced, branch naming follows git-flow, home-palette indexed PNG " +
      "export checked against ASSET_PROVENANCE.md. ";
    let body =
      "## Context\nWalk-cycle sheet generation, two-tier master-sheet + composited-motion approach.\n\n" +
      "## Acceptance\n- [ ] sheet generated\n\n";
    for (let i = 1; i <= rounds; i += 1) {
      const text =
        `Reviewer round ${i}: ${boilerplate.repeat(12)}Blocking issue: ComfyUI's ImageQuantize node ` +
        `still samples palette colors from the source image rather than the fixed home palette, so the ` +
        `exported PNG is not an exact indexed match.\n\n(run ${((i - 1) % 5) + 1} of 5)`;
      const timestamp = `2026-08-${String((i % 27) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`;
      body += `## Validation: FAIL (${timestamp})\n\n${text}\n\n`;
    }
    body += "## Validation: PASS (2026-08-28T12:00:00.000Z)\n\nfixed via T-0266's chunked/resumable generator.\n";

    const beforeBytes = Buffer.byteLength(body, "utf8");
    expect(beforeBytes).toBeGreaterThan(200_000);

    const { body: newBody, entries } = migrateBodyVerdicts(body);
    const afterBytes = Buffer.byteLength(newBody, "utf8");

    expect(entries).toHaveLength(rounds + 1);
    expect(afterBytes).toBeLessThan(beforeBytes * 0.05);
    expect(newBody).toContain("## Context");
    expect(newBody).toContain("## Acceptance");
    expect(newBody).not.toContain("Validation:");

    // No information lost: every round's full text survives in the archive entries.
    expect(entries[0].text).toContain("Reviewer round 1:");
    expect(entries[rounds - 1].text).toContain(`Reviewer round ${rounds}:`);
    expect(entries[rounds].text).toContain("fixed via T-0266");
  });
});
