import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rmTemp } from "./rmTemp.js";

describe("rmTemp", () => {
  it("removes a populated directory tree", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmtemp-"));
    await fs.mkdir(path.join(dir, "a", "b"), { recursive: true });
    await fs.writeFile(path.join(dir, "a", "b", "f.txt"), "x", "utf8");

    await rmTemp(dir);

    await expect(fs.stat(dir)).rejects.toThrow(/ENOENT/);
  });

  it("is a no-op on a directory that is already gone", async () => {
    const dir = path.join(os.tmpdir(), "rmtemp-does-not-exist-12345");
    await expect(rmTemp(dir)).resolves.toBeUndefined();
  });

  it("is a no-op on an empty path rather than removing the cwd", async () => {
    await expect(rmTemp("")).resolves.toBeUndefined();
    await expect(rmTemp(undefined)).resolves.toBeUndefined();
  });

  // The actual defect: `force: true` suppresses ENOENT but NOT ENOTEMPTY, which is what git's
  // background repacking produces when it writes into .git/objects/pack mid-teardown. Node's
  // documented remedy is maxRetries, so pin that we ask for it -- a plain
  // `fs.rm(dir, {recursive, force})` would satisfy every assertion above and still flake in CI.
  it("asks Node to retry, which is what makes it ENOTEMPTY-tolerant", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmtemp-opts-"));
    const spy = vi.spyOn(fs, "rm");
    try {
      await rmTemp(dir);
      expect(spy).toHaveBeenCalledWith(dir, expect.objectContaining({
        recursive: true,
        force: true,
        maxRetries: expect.any(Number),
        retryDelay: expect.any(Number)
      }));
      expect(spy.mock.calls[0][1].maxRetries).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("survives a directory that gains a file while it is being removed", async () => {
    // Approximates git's background write: a file lands in a nested directory after teardown
    // has started walking the tree. Without retries this is the shape that raises ENOTEMPTY.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmtemp-race-"));
    const nested = path.join(dir, "objects", "pack");
    await fs.mkdir(nested, { recursive: true });
    for (let i = 0; i < 200; i++) {
      await fs.writeFile(path.join(nested, `blob-${i}.tmp`), "x".repeat(64), "utf8");
    }

    const writer = (async () => {
      for (let i = 0; i < 40; i++) {
        try {
          await fs.writeFile(path.join(nested, `late-${i}.tmp`), "y", "utf8");
        } catch {
          break; // directory is gone -- that is the success case
        }
      }
    })();

    await rmTemp(dir);
    await writer;

    await expect(fs.stat(dir)).rejects.toThrow(/ENOENT/);
  });
});
