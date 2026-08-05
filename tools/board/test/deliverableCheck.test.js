import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkDeliverable } from "../src/lib/deliverableCheck.js";

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
});
