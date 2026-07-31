import { describe, it, expect, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile } from "../src/lib/atomicWrite.js";

let tmpDir;

afterEach(async () => {
  vi.restoreAllMocks();
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

async function makeTmpDir() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-atomic-"));
  return tmpDir;
}

async function listDir(dir) {
  return fs.readdir(dir);
}

describe("atomicWriteFile", () => {
  it("writes the given content to the target path", async () => {
    const dir = await makeTmpDir();
    const target = path.join(dir, "T-0001.md");
    await atomicWriteFile(target, "hello world");
    expect(await fs.readFile(target, "utf8")).toBe("hello world");
  });

  it("leaves no temp files behind after a successful write", async () => {
    const dir = await makeTmpDir();
    const target = path.join(dir, "T-0001.md");
    await atomicWriteFile(target, "content");
    const entries = await listDir(dir);
    expect(entries).toEqual(["T-0001.md"]);
  });

  it("overwrites an existing file atomically", async () => {
    const dir = await makeTmpDir();
    const target = path.join(dir, "T-0001.md");
    await atomicWriteFile(target, "first");
    await atomicWriteFile(target, "second");
    expect(await fs.readFile(target, "utf8")).toBe("second");
    expect(await listDir(dir)).toEqual(["T-0001.md"]);
  });

  it("leaves the original file untouched if the write step fails", async () => {
    const dir = await makeTmpDir();
    const target = path.join(dir, "T-0001.md");
    await fs.writeFile(target, "original", "utf8");

    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("disk full"));

    await expect(atomicWriteFile(target, "corrupt")).rejects.toThrow("disk full");
    expect(await fs.readFile(target, "utf8")).toBe("original");
    expect(await listDir(dir)).toEqual(["T-0001.md"]);
  });

  it("cleans up the temp file if rename fails", async () => {
    const dir = await makeTmpDir();
    const target = path.join(dir, "T-0001.md");
    await fs.writeFile(target, "original", "utf8");

    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("cross-device link"));

    await expect(atomicWriteFile(target, "corrupt")).rejects.toThrow("cross-device link");
    expect(await fs.readFile(target, "utf8")).toBe("original");
    expect(await listDir(dir)).toEqual(["T-0001.md"]);
  });
});
