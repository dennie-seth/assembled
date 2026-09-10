import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { checkDeliverable } from "../src/lib/deliverableCheck.js";
import { PRE_REGISTRATION_HEADING, FINDING_HEADING } from "../src/lib/preRegisteredFinding.js";

/** git's own blob content hash -- mirrors deliverableCheck.js's internal `gitBlobHash`. */
function gitBlobHashOf(content) {
  const bytes = Buffer.from(content);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

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
      const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
      try {
        const attachmentsDir = path.join(localDir, "attachments");
        await fs.mkdir(path.join(attachmentsDir, "T-0136"), { recursive: true });
        await fs.writeFile(path.join(attachmentsDir, "T-0136", "a.png"), "fake bytes");

        const report = await checkDeliverable(
          task({ deliverable_type: "artifact", attachments: [{ filename: "a.png" }] }),
          {
            beforeBody: "## Context\nno pre-registration\n",
            repoRoot: "/repo",
            attachmentsDir,
            fileExists: async () => true,
            listCommittedBlobs: async () => [{ hash: gitBlobHashOf("fake bytes"), path: "assets/final/a.png" }]
          }
        );
        expect(report).toEqual({ ok: true, applicable: true, errors: [] });
      } finally {
        await fs.rm(localDir, { recursive: true, force: true });
      }
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
        { attachmentsDir, repoRoot, listCommittedBlobs: async () => [] }
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

    describe("no '## Deliverable' section -- non-opt-in fallback: at least one attachment's content must match a file actually committed on the branch, outside the evidence root", () => {
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
          { attachmentsDir, repoRoot, listCommittedBlobs: async () => [] }
        );

        expect(report.applicable).toBe(true);
        expect(report.ok).toBe(false);
        expect(report.errors.join(" ")).toMatch(/committed/i);
      });

      it("T-0351 regression, the actual shape that fooled the fallback twice: evidence PNGs genuinely promoted/committed under docs/assets/evidence/T-0351/** (T-0314's own convention), no deliverable ever committed elsewhere -> still fails", async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
        const attachmentsDir = path.join(dir, "attachments");
        const repoRoot = path.join(dir, "repo");
        await fs.mkdir(repoRoot, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: repoRoot });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });

        const attachments = evidenceAttachments(6);
        await writeAttachments(attachmentsDir, "T-0351", attachments);

        // The exact thing T-0314's evidence-promotion mechanism does: commit the same attempt
        // PNGs the run attached, under the repo's own evidence root -- not as the deliverable,
        // just so they survive worktree removal.
        const evidenceDir = path.join(repoRoot, "docs", "assets", "evidence", "T-0351");
        await fs.mkdir(evidenceDir, { recursive: true });
        for (const a of attachments) {
          await fs.writeFile(path.join(evidenceDir, a.filename), "fake bytes");
        }
        execFileSync("git", ["add", "-A"], { cwd: repoRoot });
        execFileSync("git", ["commit", "-q", "-m", "evidence"], { cwd: repoRoot });

        const report = await checkDeliverable(
          task({
            id: "T-0351",
            deliverable_type: "artifact",
            attachments,
            body: "## Context\nSix failed attempts, no sheet ever assembled.\n"
          }),
          { attachmentsDir, repoRoot }
        );

        expect(report.applicable).toBe(true);
        expect(report.ok).toBe(false);
        expect(report.errors.join(" ")).toMatch(/committed/i);
      });

      it("does NOT pass on a same-named-but-different-content collision -- the exact false positive an earlier basename-only version of this fallback had on T-0351's own README.md-named evidence attachment", async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
        const attachmentsDir = path.join(dir, "attachments");
        const repoRoot = path.join(dir, "repo");
        await fs.mkdir(repoRoot, { recursive: true });

        // Same filename as a real committed file, but different content -- an evidence-summary
        // upload, not the repo's actual README.md.
        const attachments = [{ filename: "README.md" }];
        await writeAttachments(attachmentsDir, "T-0351", attachments);

        const report = await checkDeliverable(
          task({ id: "T-0351", deliverable_type: "artifact", attachments, body: "## Context\nno deliverable section here\n" }),
          {
            attachmentsDir,
            repoRoot,
            listCommittedBlobs: async () => [{ hash: gitBlobHashOf("totally different content"), path: "README.md" }]
          }
        );
        expect(report.ok).toBe(false);
        expect(report.errors.join(" ")).toMatch(/committed/i);
      });

      it("passes once at least one recorded attachment's content matches a file actually committed outside the evidence root, even with no '## Deliverable' section", async () => {
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
            // writeAttachments writes "fake bytes" for every attachment -- this is the blob hash
            // a real committed `assets/final/character/t0351_master_sheet.png` would have if its
            // content matched the promoted attachment.
            listCommittedBlobs: async () => [
              { hash: gitBlobHashOf("fake bytes"), path: "assets/final/character/t0351_master_sheet.png" }
            ]
          }
        );
        expect(report).toEqual({ ok: true, applicable: true, errors: [] });
      });

      it("a committed match that lives ONLY under the evidence root does not count, even when its content also happens to match an attachment -- the fallback must look at path, not just hash", async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
        const attachmentsDir = path.join(dir, "attachments");
        const repoRoot = path.join(dir, "repo");
        await fs.mkdir(repoRoot, { recursive: true });

        const attachments = [{ filename: "attempt_1_main.png" }];
        await writeAttachments(attachmentsDir, "T-0351", attachments);

        const report = await checkDeliverable(
          task({ id: "T-0351", deliverable_type: "artifact", attachments, body: "## Context\nno deliverable section here\n" }),
          {
            attachmentsDir,
            repoRoot,
            listCommittedBlobs: async () => [
              { hash: gitBlobHashOf("fake bytes"), path: "docs/assets/evidence/T-0351/attempt_1_main.png" }
            ]
          }
        );
        expect(report.ok).toBe(false);
        expect(report.errors.join(" ")).toMatch(/committed/i);
      });

      it("default listCommittedBlobs (real git): passes for content that's actually git-committed in repoRoot outside the evidence root, fails for content that's only untracked/uncommitted", async () => {
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

        // Uploaded attachment's content is byte-identical to the committed sheet -- a genuine
        // promoted deliverable, not merely a same-named file.
        const committedAttachments = [{ filename: "committed_sheet.png" }];
        const committedCardDir = path.join(attachmentsDir, "T-0500");
        await fs.mkdir(committedCardDir, { recursive: true });
        await fs.writeFile(path.join(committedCardDir, "committed_sheet.png"), "real sheet bytes");
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

        // Same filename, but content was never committed (and differs from the committed file).
        const untrackedAttachments = [{ filename: "committed_sheet.png" }];
        const untrackedCardDir = path.join(attachmentsDir, "T-0501");
        await fs.mkdir(untrackedCardDir, { recursive: true });
        await fs.writeFile(path.join(untrackedCardDir, "committed_sheet.png"), "never committed, different bytes");
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

        // Real git, real evidence-promotion path: content that IS committed, but only inside
        // docs/assets/evidence/**, must not satisfy the fallback either.
        const evidenceDir = path.join(repoRoot, "docs", "assets", "evidence", "T-0502");
        await fs.mkdir(evidenceDir, { recursive: true });
        await fs.writeFile(path.join(evidenceDir, "attempt_1.png"), "evidence-only bytes");
        execFileSync("git", ["add", "-A"], { cwd: repoRoot });
        execFileSync("git", ["commit", "-q", "-m", "evidence"], { cwd: repoRoot });

        const evidenceOnlyAttachments = [{ filename: "attempt_1.png" }];
        const evidenceOnlyCardDir = path.join(attachmentsDir, "T-0502");
        await fs.mkdir(evidenceOnlyCardDir, { recursive: true });
        await fs.writeFile(path.join(evidenceOnlyCardDir, "attempt_1.png"), "evidence-only bytes");
        const evidenceOnlyReport = await checkDeliverable(
          task({
            id: "T-0502",
            deliverable_type: "artifact",
            attachments: evidenceOnlyAttachments,
            body: "## Context\nno deliverable section here\n"
          }),
          { attachmentsDir, repoRoot }
        );
        expect(evidenceOnlyReport.ok).toBe(false);
        expect(evidenceOnlyReport.errors.join(" ")).toMatch(/committed/i);
      });

      describe("Git-LFS-tracked deliverables (T-0352 iter-3 reviewer FAIL): the fallback must not false-positive-fail a genuinely committed LFS asset", () => {
        it("an attachment whose sha256 matches a committed LFS pointer's oid counts as committed, even though the pointer blob's own git hash never equals gitBlobHash(realBytes)", async () => {
          dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
          const attachmentsDir = path.join(dir, "attachments");
          const repoRoot = path.join(dir, "repo");
          await fs.mkdir(repoRoot, { recursive: true });

          const realBytes = Buffer.from("real audio bytes, standing in for an LFS-tracked .wav");
          const oid = createHash("sha256").update(realBytes).digest("hex");
          const pointerContent = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${realBytes.length}\n`;

          const attachments = [{ filename: "door.wav" }];
          await writeAttachments(attachmentsDir, "T-0500", attachments);
          await fs.writeFile(path.join(attachmentsDir, "T-0500", "door.wav"), realBytes);

          const report = await checkDeliverable(
            task({ id: "T-0500", deliverable_type: "artifact", attachments, body: "## Context\nno deliverable section here\n" }),
            {
              attachmentsDir,
              repoRoot,
              // The blob git actually committed is the LFS *pointer* text, not realBytes -- its
              // git blob hash never equals gitBlobHash(realBytes). Only its sha256 oid does.
              listCommittedBlobs: async () => [
                { hash: gitBlobHashOf(pointerContent), path: "assets/final/audio/door.wav", lfsOid: oid }
              ]
            }
          );
          expect(report).toEqual({ ok: true, applicable: true, errors: [] });
        });

        it("a committed LFS pointer whose oid does NOT match the attachment's content still fails -- an lfsOid field alone isn't proof", async () => {
          dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
          const attachmentsDir = path.join(dir, "attachments");
          const repoRoot = path.join(dir, "repo");
          await fs.mkdir(repoRoot, { recursive: true });

          const attachments = [{ filename: "door.wav" }];
          await writeAttachments(attachmentsDir, "T-0501", attachments);
          await fs.writeFile(path.join(attachmentsDir, "T-0501", "door.wav"), "never actually committed bytes");

          const report = await checkDeliverable(
            task({ id: "T-0501", deliverable_type: "artifact", attachments, body: "## Context\nno deliverable section here\n" }),
            {
              attachmentsDir,
              repoRoot,
              listCommittedBlobs: async () => [
                {
                  hash: gitBlobHashOf("irrelevant pointer text"),
                  path: "assets/final/audio/door.wav",
                  lfsOid: createHash("sha256").update("completely different content").digest("hex")
                }
              ]
            }
          );
          expect(report.ok).toBe(false);
          expect(report.errors.join(" ")).toMatch(/committed/i);
        });

        it("default listCommittedBlobs (real git + git-lfs): passes for a genuinely LFS-tracked deliverable -- the exact T-0352 iter-3 reviewer false-negative, reproduced against real git-lfs", async () => {
          dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
          const attachmentsDir = path.join(dir, "attachments");
          const repoRoot = path.join(dir, "repo");
          await fs.mkdir(repoRoot, { recursive: true });
          execFileSync("git", ["init", "-q"], { cwd: repoRoot });
          execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
          execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
          execFileSync("git", ["lfs", "install", "--local"], { cwd: repoRoot });
          await fs.writeFile(
            path.join(repoRoot, ".gitattributes"),
            "assets/final/audio/*.wav filter=lfs diff=lfs merge=lfs -text\n"
          );

          const audioDir = path.join(repoRoot, "assets", "final", "audio");
          await fs.mkdir(audioDir, { recursive: true });
          const realBytes = Buffer.from("a".repeat(4096));
          await fs.writeFile(path.join(audioDir, "door.wav"), realBytes);
          execFileSync("git", ["add", "-A"], { cwd: repoRoot });
          execFileSync("git", ["commit", "-q", "-m", "lfs asset"], { cwd: repoRoot });

          // Sanity: the committed blob really is a pointer, not the real bytes -- otherwise this
          // test isn't exercising LFS at all.
          const committedContent = execFileSync("git", ["show", "HEAD:assets/final/audio/door.wav"], {
            cwd: repoRoot
          }).toString();
          expect(committedContent).toMatch(/^version https:\/\/git-lfs\.github\.com\/spec\/v1/);

          const attachments = [{ filename: "door.wav" }];
          await writeAttachments(attachmentsDir, "T-0503", attachments);
          await fs.writeFile(path.join(attachmentsDir, "T-0503", "door.wav"), realBytes);

          const report = await checkDeliverable(
            task({ id: "T-0503", deliverable_type: "artifact", attachments, body: "## Context\nno deliverable section here\n" }),
            { attachmentsDir, repoRoot }
          );
          expect(report).toEqual({ ok: true, applicable: true, errors: [] });
        });
      });
    });

    describe("freshness (T-0354) -- existence alone is not enough; the verified path must have been touched since this run started", () => {
      it("T-0351 regression, exact case: generator code extended, tests green, two commits, zero new images -- a previously-promoted artifact does not rescue this run", async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
        const attachmentsDir = path.join(dir, "attachments");
        const repoRoot = path.join(dir, "repo");
        const sheetDir = path.join(repoRoot, "assets", "final", "character");
        await fs.mkdir(sheetDir, { recursive: true });
        await fs.writeFile(path.join(sheetDir, "t0351_master_sheet.png"), "real sheet bytes");

        const attachments = [{ filename: "t0351_master_sheet.png" }];
        await writeAttachments(attachmentsDir, "T-0351", attachments);

        const body = "## Deliverable\n`assets/final/character/t0351_master_sheet.png`\n";

        const report = await checkDeliverable(
          task({ id: "T-0351", deliverable_type: "artifact", attachments, body }),
          {
            attachmentsDir,
            repoRoot,
            runStartTime: "2026-09-10T12:00:00Z",
            // The T-0351 shape: two real commits this run, nine seconds apart, touching only
            // generator/test .py files -- never the image itself.
            listCommitsSince: async () => [
              {
                sha: "c1",
                message: "feat: T-0351 Tier-1 master sheet REGEN in limb-separating poses",
                changedPaths: ["assets/src/character/gen_master_sheet.py"]
              },
              {
                sha: "c2",
                message: "test: T-0351 GREEN",
                changedPaths: ["assets/src/character/tests/test_master_sheet.py"]
              }
            ]
          }
        );

        expect(report.applicable).toBe(true);
        expect(report.ok).toBe(false);
        expect(report.errors.join(" ")).toMatch(/t0351_master_sheet\.png/);
      });

      it("passes when the verified deliverable path WAS touched by a commit made since this run started (the model actually ran)", async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
        const attachmentsDir = path.join(dir, "attachments");
        const repoRoot = path.join(dir, "repo");
        const sheetDir = path.join(repoRoot, "assets", "final", "character");
        await fs.mkdir(sheetDir, { recursive: true });
        await fs.writeFile(path.join(sheetDir, "t0351_master_sheet.png"), "freshly regenerated bytes");

        const attachments = [{ filename: "t0351_master_sheet.png" }];
        await writeAttachments(attachmentsDir, "T-0351", attachments);

        const body = "## Deliverable\n`assets/final/character/t0351_master_sheet.png`\n";

        const report = await checkDeliverable(
          task({ id: "T-0351", deliverable_type: "artifact", attachments, body }),
          {
            attachmentsDir,
            repoRoot,
            runStartTime: "2026-09-10T12:00:00Z",
            listCommitsSince: async () => [
              {
                sha: "c1",
                message: "feat: T-0351 regenerate master sheet via ComfyUI",
                changedPaths: ["assets/final/character/t0351_master_sheet.png"]
              }
            ]
          }
        );

        expect(report).toEqual({ ok: true, applicable: true, errors: [] });
      });

      it("a genuine host outage this run is distinguishable and not punished -- a card comment/commit carrying a host-action-request block still passes even with no fresh artifact", async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
        const attachmentsDir = path.join(dir, "attachments");
        const repoRoot = path.join(dir, "repo");
        const sheetDir = path.join(repoRoot, "assets", "final", "character");
        await fs.mkdir(sheetDir, { recursive: true });
        await fs.writeFile(path.join(sheetDir, "t0351_master_sheet.png"), "real sheet bytes");

        const attachments = [{ filename: "t0351_master_sheet.png" }];
        await writeAttachments(attachmentsDir, "T-0351", attachments);

        const body = "## Deliverable\n`assets/final/character/t0351_master_sheet.png`\n";

        const report = await checkDeliverable(
          task({ id: "T-0351", deliverable_type: "artifact", attachments, body }),
          {
            attachmentsDir,
            repoRoot,
            runStartTime: "2026-09-10T12:00:00Z",
            listCommitsSince: async () => [
              {
                sha: "c1",
                message:
                  "docs: T-0351 host outage\n\n```host-action-request\nhost: Windows ComfyUI host (F:\\ComfyUI)\naction: restart the ComfyUI service\nreason: no shell on the host from this WSL2 worktree\nverify: curl http://172.18.192.1:8188/system_stats returns 200\n```",
                changedPaths: ["tasks/T-0351.md"]
              }
            ]
          }
        );

        expect(report).toEqual({ ok: true, applicable: true, errors: [] });
      });

      it("a pre-registered finding run (T-0342) still passes without a fresh artifact -- freshness is only consulted once existence already passed", async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
        const repoRoot = path.join(dir, "repo");
        const evidenceDir = path.join(repoRoot, "docs", "assets", "evidence", "T-0259");
        await fs.mkdir(evidenceDir, { recursive: true });
        await fs.writeFile(path.join(evidenceDir, "attempt_8_main.png"), "evidence bytes");

        const preRegisteredBefore = `${PRE_REGISTRATION_HEADING}\nIf X, the arm is falsified.\n`;
        const decisiveFindingBody = `${FINDING_HEADING}\nThe result is decisive: falsified. See \`docs/assets/evidence/T-0259/attempt_8_main.png\`.\n`;

        const report = await checkDeliverable(
          task({ id: "T-0259", deliverable_type: "artifact", attachments: [], body: decisiveFindingBody }),
          {
            beforeBody: preRegisteredBefore,
            repoRoot,
            runStartTime: "2026-09-10T12:00:00Z",
            listCommitsSince: async () => []
          }
        );

        expect(report).toEqual({ ok: true, applicable: true, errors: [] });
      });

      it("code-deliverable cards are unaffected -- freshness never applies when the card isn't an artifact route at all", async () => {
        const report = await checkDeliverable(task({ deliverable_type: "code" }), {
          repoRoot: "/repo",
          runStartTime: "2026-09-10T12:00:00Z",
          listCommitsSince: async () => {
            throw new Error("must not be called for a code-deliverable card");
          }
        });
        expect(report).toEqual({ ok: true, applicable: false, errors: [] });
      });

      it("does not run freshness (or call listCommitsSince) when runStartTime is not supplied -- backward compatible with every existing caller", async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "deliverable-check-"));
        const attachmentsDir = path.join(dir, "attachments");
        const repoRoot = path.join(dir, "repo");
        const sheetDir = path.join(repoRoot, "assets", "final", "character");
        await fs.mkdir(sheetDir, { recursive: true });
        await fs.writeFile(path.join(sheetDir, "t0351_master_sheet.png"), "real sheet bytes");

        const attachments = [{ filename: "t0351_master_sheet.png" }];
        await writeAttachments(attachmentsDir, "T-0351", attachments);
        const body = "## Deliverable\n`assets/final/character/t0351_master_sheet.png`\n";

        const report = await checkDeliverable(
          task({ id: "T-0351", deliverable_type: "artifact", attachments, body }),
          {
            attachmentsDir,
            repoRoot,
            listCommitsSince: async () => {
              throw new Error("must not be called when runStartTime is absent");
            }
          }
        );

        expect(report).toEqual({ ok: true, applicable: true, errors: [] });
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
