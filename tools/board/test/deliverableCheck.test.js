import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { checkDeliverable } from "../src/lib/deliverableCheck.js";
import { PRE_REGISTRATION_HEADING, FINDING_HEADING } from "../src/lib/preRegisteredFinding.js";

function task(overrides = {}) {
  return {
    id: "T-0136",
    deliverable_type: "code",
    attachments: [],
    ...overrides
  };
}

describe("checkDeliverable", () => {
  it("is not applicable for deliverable_type: 'code' (the default) -- always passes, nothing to check", async () => {
    const report = await checkDeliverable(task({ deliverable_type: "code" }));
    expect(report).toEqual({ ok: true, applicable: false, errors: [] });
  });

  it("is not applicable when deliverable_type is absent", async () => {
    const t = task();
    delete t.deliverable_type;
    const report = await checkDeliverable(t);
    expect(report.applicable).toBe(false);
    expect(report.ok).toBe(true);
  });

  it("is not applicable when task itself is missing", async () => {
    const report = await checkDeliverable(undefined);
    expect(report).toEqual({ ok: true, applicable: false, errors: [] });
  });

  it("fails an artifact card with no attachments recorded -- the T-0136 failure mode", async () => {
    const report = await checkDeliverable(task({ deliverable_type: "artifact", attachments: [] }));
    expect(report.applicable).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(/no attachments recorded/i);
    expect(report.errors[0]).toContain("T-0136");
  });

  it("passes an artifact card with attachments recorded when no attachmentsDir is given (frontmatter-only check)", async () => {
    const report = await checkDeliverable(
      task({ deliverable_type: "artifact", attachments: [{ filename: "a.png" }] })
    );
    expect(report.ok).toBe(true);
    expect(report.applicable).toBe(true);
    expect(report.errors).toEqual([]);
  });

  describe("requireArtifact -- forces applicability regardless of deliverable_type (the T-0198/T-0209/T-0202 gap)", () => {
    it("is not applicable for a code-deliverable card when requireArtifact is not set (unchanged default)", async () => {
      const report = await checkDeliverable(task({ deliverable_type: "code" }));
      expect(report.applicable).toBe(false);
    });

    it("becomes applicable for a code-deliverable card when requireArtifact is true", async () => {
      const report = await checkDeliverable(task({ deliverable_type: "code", attachments: [] }), {
        requireArtifact: true
      });
      expect(report.applicable).toBe(true);
      expect(report.ok).toBe(false);
      expect(report.errors[0]).toMatch(/no attachments recorded/i);
    });

    it("passes a code-deliverable card under requireArtifact when it does have an attachment recorded", async () => {
      const report = await checkDeliverable(
        task({ deliverable_type: "code", attachments: [{ filename: "sheet.png" }] }),
        { requireArtifact: true }
      );
      expect(report.applicable).toBe(true);
      expect(report.ok).toBe(true);
    });

    it("requireArtifact is still a no-op when the task is already deliverable_type: 'artifact' (same result either way)", async () => {
      const withFlag = await checkDeliverable(task({ deliverable_type: "artifact", attachments: [] }), {
        requireArtifact: true
      });
      const withoutFlag = await checkDeliverable(task({ deliverable_type: "artifact", attachments: [] }));
      expect(withFlag).toEqual(withoutFlag);
    });

    it("requireArtifact has no effect when the task itself is missing", async () => {
      const report = await checkDeliverable(undefined, { requireArtifact: true });
      expect(report).toEqual({ ok: true, applicable: false, errors: [] });
    });
  });

  describe("with attachmentsDir -- cross-checks the frontmatter claim against real files", () => {
    let dir;

    afterEach(async () => {
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    });

    it("passes when every recorded attachment's file actually exists on disk", async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
      const cardDir = path.join(dir, "T-0136");
      await fs.mkdir(cardDir, { recursive: true });
      await fs.writeFile(path.join(cardDir, "a.png"), "fake image bytes");

      const report = await checkDeliverable(
        task({ deliverable_type: "artifact", attachments: [{ filename: "a.png" }] }),
        { attachmentsDir: dir }
      );
      expect(report.ok).toBe(true);
    });

    it("fails when a recorded attachment's file is missing on disk (frontmatter claims it, disk disagrees)", async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
      // no files written -- the card dir doesn't even exist

      const report = await checkDeliverable(
        task({ deliverable_type: "artifact", attachments: [{ filename: "missing.png" }] }),
        { attachmentsDir: dir }
      );
      expect(report.ok).toBe(false);
      expect(report.errors[0]).toContain("missing.png");
      expect(report.errors[0]).toMatch(/does not exist/i);
    });

    it("reports each missing attachment independently when several are missing", async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));

      const report = await checkDeliverable(
        task({
          deliverable_type: "artifact",
          attachments: [{ filename: "a.png" }, { filename: "b.png" }]
        }),
        { attachmentsDir: dir }
      );
      expect(report.errors).toHaveLength(2);
    });
  });

  describe("finding-with-evidence route (T-0342) -- a pre-registered, decisive, evidenced finding can PASS in place of a promoted artifact", () => {
    const evidencePath = "docs/assets/evidence/T-0136/attempt_8_main.png";
    const preRegisteredBefore = `${PRE_REGISTRATION_HEADING}\nIf X, the arm is falsified.\n`;
    const decisiveFindingBody = `${FINDING_HEADING}\nThe result is decisive: falsified. See \`${evidencePath}\`.\n`;

    it("PASSes with no attachments when beforeBody pre-registered and the current body has a decisive, evidenced finding", async () => {
      const report = await checkDeliverable(
        task({ deliverable_type: "artifact", attachments: [], body: decisiveFindingBody }),
        { beforeBody: preRegisteredBefore, repoRoot: "/repo", fileExists: async () => true }
      );
      expect(report).toEqual({ ok: true, applicable: true, errors: [] });
    });

    it("still FAILs when no attachments and beforeBody did NOT pre-register (current body having it doesn't count -- cannot rescue an empty run retroactively)", async () => {
      const report = await checkDeliverable(
        task({
          deliverable_type: "artifact",
          attachments: [],
          body: preRegisteredBefore + "\n" + decisiveFindingBody
        }),
        { beforeBody: "## Context\nnothing pre-registered\n", repoRoot: "/repo", fileExists: async () => true }
      );
      expect(report.ok).toBe(false);
      expect(report.applicable).toBe(true);
      expect(report.errors.join(" ")).toMatch(/no attachments recorded/i);
    });

    it("still FAILs with no attachments, no pre-registration at all, and no finding (baseline unchanged)", async () => {
      const report = await checkDeliverable(
        task({ deliverable_type: "artifact", attachments: [], body: "## Context\nnothing here\n" }),
        { beforeBody: "## Context\nnothing pre-registered\n", repoRoot: "/repo", fileExists: async () => true }
      );
      expect(report.ok).toBe(false);
      expect(report.applicable).toBe(true);
    });

    it("FAILs (with both the attachment error and the finding error) when pre-registered but the finding isn't decisive", async () => {
      const report = await checkDeliverable(
        task({
          deliverable_type: "artifact",
          attachments: [],
          body: `${FINDING_HEADING}\nInconclusive, see \`${evidencePath}\`\n`
        }),
        { beforeBody: preRegisteredBefore, repoRoot: "/repo", fileExists: async () => true }
      );
      expect(report.ok).toBe(false);
      const joined = report.errors.join(" ");
      expect(joined).toMatch(/no attachments recorded/i);
      expect(joined).toMatch(/decisive/i);
    });

    it("is not consulted when the plain artifact/attachment check already passes (beforeBody irrelevant)", async () => {
      const report = await checkDeliverable(
        task({ deliverable_type: "artifact", attachments: [{ filename: "a.png" }] }),
        { beforeBody: "## Context\nno pre-registration\n", repoRoot: "/repo", fileExists: async () => true }
      );
      expect(report).toEqual({ ok: true, applicable: true, errors: [] });
    });

    it("does not apply the finding-with-evidence route to a requireArtifact (diff-triggered) card whose deliverable_type is not 'artifact'", async () => {
      const report = await checkDeliverable(
        task({ deliverable_type: "code", attachments: [], body: decisiveFindingBody }),
        { requireArtifact: true, beforeBody: preRegisteredBefore, repoRoot: "/repo", fileExists: async () => true }
      );
      expect(report.ok).toBe(false);
      expect(report.errors.join(" ")).toMatch(/no attachments recorded/i);
    });
  });

  describe("'## Deliverable' section (T-0352) -- a declared, committed path distinguishes the deliverable from evidence attachments", () => {
    let dir;

    afterEach(async () => {
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    });

    function evidenceAttachments(count) {
      return Array.from({ length: count }, (_, i) => ({ filename: `attempt_${i + 1}_main.png` }));
    }

    async function writeAttachments(attachmentsDir, id, attachments) {
      const cardDir = path.join(attachmentsDir, id);
      await fs.mkdir(cardDir, { recursive: true });
      for (const a of attachments) {
        await fs.writeFile(path.join(cardDir, a.filename), "fake bytes");
      }
    }

    it("declared-path route: fails when a card declares its deliverable's path but it was never committed", async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
      const attachmentsDir = path.join(dir, "attachments");
      const repoRoot = path.join(dir, "repo");
      await fs.mkdir(repoRoot, { recursive: true });

      const attachments = evidenceAttachments(6);
      await writeAttachments(attachmentsDir, "T-0351", attachments);

      const body =
        "## Deliverable\n`assets/final/character/t0351_master_sheet.png`\n\n" +
        "## Context\nSix failed attempts, no sheet ever assembled.\n";

      const report = await checkDeliverable(
        task({ id: "T-0351", deliverable_type: "artifact", attachments, body }),
        { attachmentsDir, repoRoot, listCommittedFiles: async () => [] }
      );

      expect(report.applicable).toBe(true);
      expect(report.ok).toBe(false);
      expect(report.errors.join(" ")).toMatch(/assets\/final\/character\/t0351_master_sheet\.png/);
      expect(report.errors.join(" ")).toMatch(/Deliverable/);
    });

    it("passes a genuine artifact card once the declared deliverable is actually committed, even alongside extra evidence attachments", async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
      const attachmentsDir = path.join(dir, "attachments");
      const repoRoot = path.join(dir, "repo");
      const sheetDir = path.join(repoRoot, "assets", "final", "character");
      await fs.mkdir(sheetDir, { recursive: true });
      await fs.writeFile(path.join(sheetDir, "t0351_master_sheet.png"), "real sheet bytes");

      const attachments = [...evidenceAttachments(2), { filename: "t0351_master_sheet.png" }];
      await writeAttachments(attachmentsDir, "T-0351", attachments);

      const body = "## Deliverable\n`assets/final/character/t0351_master_sheet.png`\n";

      const report = await checkDeliverable(
        task({ id: "T-0351", deliverable_type: "artifact", attachments, body }),
        { attachmentsDir, repoRoot }
      );

      expect(report).toEqual({ ok: true, applicable: true, errors: [] });
    });

    it("multi-artifact cards: fails naming exactly the one declared path still missing, passes once every declared path is committed", async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
      const attachmentsDir = path.join(dir, "attachments");
      const repoRoot = path.join(dir, "repo");
      const finalDir = path.join(repoRoot, "assets", "final", "pose-set");
      await fs.mkdir(finalDir, { recursive: true });
      await fs.writeFile(path.join(finalDir, "idle.png"), "idle bytes");
      await fs.writeFile(path.join(finalDir, "walk.png"), "walk bytes");

      const attachments = [{ filename: "idle.png" }, { filename: "walk.png" }, { filename: "run.png" }];
      await writeAttachments(attachmentsDir, "T-0400", attachments);

      const body =
        "## Deliverable\n" +
        "`assets/final/pose-set/idle.png`\n" +
        "`assets/final/pose-set/walk.png`\n" +
        "`assets/final/pose-set/run.png`\n";

      const failing = await checkDeliverable(
        task({ id: "T-0400", deliverable_type: "artifact", attachments, body }),
        { attachmentsDir, repoRoot }
      );
      expect(failing.ok).toBe(false);
      expect(failing.errors.join(" ")).toMatch(/pose-set\/run\.png/);
      expect(failing.errors.join(" ")).not.toMatch(/pose-set\/idle\.png/);

      await fs.writeFile(path.join(finalDir, "run.png"), "run bytes");

      const passing = await checkDeliverable(
        task({ id: "T-0400", deliverable_type: "artifact", attachments, body }),
        { attachmentsDir, repoRoot }
      );
      expect(passing).toEqual({ ok: true, applicable: true, errors: [] });
    });

    describe("no '## Deliverable' section -- non-opt-in fallback: at least one attachment must correspond to a file actually committed on the branch", () => {
      it("T-0351 regression (exact shape, no card-side opt-in): six evidence PNGs attached and present on disk, no '## Deliverable' section, none of them committed anywhere in the repo -> fails", async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
        const attachmentsDir = path.join(dir, "attachments");
        const repoRoot = path.join(dir, "repo");
        await fs.mkdir(repoRoot, { recursive: true });

        const attachments = evidenceAttachments(6);
        await writeAttachments(attachmentsDir, "T-0351", attachments);

        const report = await checkDeliverable(
          task({
            id: "T-0351",
            deliverable_type: "artifact",
            attachments,
            body: "## Context\nSix failed attempts, no sheet ever assembled.\n"
          }),
          { attachmentsDir, repoRoot, listCommittedFiles: async () => [] }
        );

        expect(report.applicable).toBe(true);
        expect(report.ok).toBe(false);
        expect(report.errors.join(" ")).toMatch(/committed/i);
      });

      it("passes once at least one recorded attachment corresponds to a file actually committed on the branch, even with no '## Deliverable' section", async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
        const attachmentsDir = path.join(dir, "attachments");
        const repoRoot = path.join(dir, "repo");
        await fs.mkdir(repoRoot, { recursive: true });

        const attachments = [...evidenceAttachments(2), { filename: "t0351_master_sheet.png" }];
        await writeAttachments(attachmentsDir, "T-0351", attachments);

        const report = await checkDeliverable(
          task({ id: "T-0351", deliverable_type: "artifact", attachments, body: "## Context\nno deliverable section here\n" }),
          {
            attachmentsDir,
            repoRoot,
            listCommittedFiles: async () => [
              "assets/final/character/t0351_master_sheet.png",
              "README.md"
            ]
          }
        );
        expect(report).toEqual({ ok: true, applicable: true, errors: [] });
      });

      it("still fails when attachments are present on disk but none of their filenames match any committed file, even with a non-empty committed file list", async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
        const attachmentsDir = path.join(dir, "attachments");
        const repoRoot = path.join(dir, "repo");
        await fs.mkdir(repoRoot, { recursive: true });

        const attachments = [{ filename: "a.png" }];
        await writeAttachments(attachmentsDir, "T-0136", attachments);

        const report = await checkDeliverable(
          task({ deliverable_type: "artifact", attachments, body: "## Context\nno deliverable section here\n" }),
          { attachmentsDir, repoRoot, listCommittedFiles: async () => ["docs/unrelated.md"] }
        );
        expect(report.ok).toBe(false);
        expect(report.errors.join(" ")).toMatch(/committed/i);
      });

      it("default listCommittedFiles (real git): passes for a filename that's actually git-committed in repoRoot, fails for one that's only untracked/uncommitted", async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
        const attachmentsDir = path.join(dir, "attachments");
        const repoRoot = path.join(dir, "repo");
        await fs.mkdir(repoRoot, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: repoRoot });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
        const sheetDir = path.join(repoRoot, "assets", "final", "character");
        await fs.mkdir(sheetDir, { recursive: true });
        await fs.writeFile(path.join(sheetDir, "committed_sheet.png"), "real sheet bytes");
        execFileSync("git", ["add", "-A"], { cwd: repoRoot });
        execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
        await fs.writeFile(path.join(sheetDir, "untracked_sheet.png"), "never committed");

        const committedAttachments = [{ filename: "committed_sheet.png" }];
        await writeAttachments(attachmentsDir, "T-0500", committedAttachments);
        const passing = await checkDeliverable(
          task({
            id: "T-0500",
            deliverable_type: "artifact",
            attachments: committedAttachments,
            body: "## Context\nno deliverable section here\n"
          }),
          { attachmentsDir, repoRoot }
        );
        expect(passing).toEqual({ ok: true, applicable: true, errors: [] });

        const untrackedAttachments = [{ filename: "untracked_sheet.png" }];
        await writeAttachments(attachmentsDir, "T-0501", untrackedAttachments);
        const failing = await checkDeliverable(
          task({
            id: "T-0501",
            deliverable_type: "artifact",
            attachments: untrackedAttachments,
            body: "## Context\nno deliverable section here\n"
          }),
          { attachmentsDir, repoRoot }
        );
        expect(failing.ok).toBe(false);
        expect(failing.errors.join(" ")).toMatch(/committed/i);
      });
    });

    it("does not break the T-0342 finding-with-evidence route for a card with no '## Deliverable' section", async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
      const repoRoot = path.join(dir, "repo");
      const evidenceDir = path.join(repoRoot, "docs", "assets", "evidence", "T-0259");
      await fs.mkdir(evidenceDir, { recursive: true });
      await fs.writeFile(path.join(evidenceDir, "attempt_8_main.png"), "evidence bytes");

      const preRegisteredBefore = `${PRE_REGISTRATION_HEADING}\nIf X, the arm is falsified.\n`;
      const decisiveFindingBody = `${FINDING_HEADING}\nThe result is decisive: falsified. See \`docs/assets/evidence/T-0259/attempt_8_main.png\`.\n`;

      const report = await checkDeliverable(
        task({ id: "T-0259", deliverable_type: "artifact", attachments: [], body: decisiveFindingBody }),
        { beforeBody: preRegisteredBefore, repoRoot }
      );

      expect(report).toEqual({ ok: true, applicable: true, errors: [] });
    });
  });
});
