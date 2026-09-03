import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { approvalProvenanceStaleNotice } from "../src/lib/approvalProvenanceNotice.js";

/**
 * `approvalProvenanceStaleNotice` (T-0286): the live counterpart to
 * `checkApprovalProvenanceDrift.js`'s CI check, for the one thing CI structurally cannot do --
 * read the board's own live approval record and the current `ASSET_PROVENANCE.md` together, on
 * the same machine, at the exact moment a human's approval is stamped (`httpApi.js`'s two
 * approval write paths). This is where the T-0257/T-0243 drift could have surfaced live on
 * 2026-08-30 instead of sitting unnoticed for days -- no CI, no git diff, no data-source gap:
 * the repo checkout the board server runs against *is* the real one.
 */
function task(overrides = {}) {
  return {
    id: "T-0257",
    requires_approval: true,
    approved_by: "Anonymous",
    approved_at: "2026-08-30T22:06:35.073Z",
    ...overrides
  };
}

describe("approvalProvenanceStaleNotice", () => {
  let repoRoot;

  beforeAll(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "board-provenance-notice-"));
  });

  afterAll(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("returns a notice when the just-approved card's provenance row still reads unapproved", async () => {
    await writeFile(
      path.join(repoRoot, "ASSET_PROVENANCE.md"),
      "| sheet.png (T-0257 -- not yet approved) | MIT | ... |\n"
    );

    const notice = await approvalProvenanceStaleNotice({ repoRoot, task: task() });

    expect(notice).not.toBeNull();
    expect(notice).toContain("T-0257");
    expect(notice.toLowerCase()).toContain("board");
  });

  it("returns null when the provenance row already agrees with the board", async () => {
    await writeFile(
      path.join(repoRoot, "ASSET_PROVENANCE.md"),
      "| sheet.png (T-0257 -- **APPROVED 2026-08-30**) | MIT | ... |\n"
    );

    const notice = await approvalProvenanceStaleNotice({ repoRoot, task: task() });

    expect(notice).toBeNull();
  });

  it("returns null when ASSET_PROVENANCE.md has no row for this card at all", async () => {
    await writeFile(path.join(repoRoot, "ASSET_PROVENANCE.md"), "| other.png (T-0001) | MIT | ... |\n");

    const notice = await approvalProvenanceStaleNotice({ repoRoot, task: task() });

    expect(notice).toBeNull();
  });

  it("returns null (never throws) when ASSET_PROVENANCE.md does not exist", async () => {
    const emptyRoot = await mkdtemp(path.join(tmpdir(), "board-provenance-notice-empty-"));
    try {
      const notice = await approvalProvenanceStaleNotice({ repoRoot: emptyRoot, task: task() });
      expect(notice).toBeNull();
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it("never rewrites ASSET_PROVENANCE.md -- read-only, same as the CI check", async () => {
    const provenancePath = path.join(repoRoot, "ASSET_PROVENANCE.md");
    const original = "| sheet.png (T-0257 -- not yet approved) | MIT | ... |\n";
    await writeFile(provenancePath, original);

    await approvalProvenanceStaleNotice({ repoRoot, task: task() });

    const { readFile } = await import("node:fs/promises");
    expect(await readFile(provenancePath, "utf8")).toBe(original);
  });
});
