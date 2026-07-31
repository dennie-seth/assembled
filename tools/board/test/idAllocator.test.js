import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IdAllocator } from "../src/lib/idAllocator.js";

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-idalloc-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("IdAllocator", () => {
  it("allocates T-0001 in an empty directory", async () => {
    const allocator = new IdAllocator(tmpDir);
    expect(await allocator.allocate()).toBe("T-0001");
  });

  it("allocates sequential ids across successive calls", async () => {
    const allocator = new IdAllocator(tmpDir);
    expect(await allocator.allocate()).toBe("T-0001");
    expect(await allocator.allocate()).toBe("T-0002");
    expect(await allocator.allocate()).toBe("T-0003");
  });

  it("is gap-tolerant: jumps to max+1 when existing task files have gaps", async () => {
    await fs.writeFile(path.join(tmpDir, "T-0001.md"), "", "utf8");
    await fs.writeFile(path.join(tmpDir, "T-0002.md"), "", "utf8");
    await fs.writeFile(path.join(tmpDir, "T-0005.md"), "", "utf8");

    const allocator = new IdAllocator(tmpDir);
    expect(await allocator.allocate()).toBe("T-0006");
  });

  it("never reuses an id after its task file is deleted", async () => {
    const allocator = new IdAllocator(tmpDir);
    const first = await allocator.allocate();
    const second = await allocator.allocate();
    await fs.writeFile(path.join(tmpDir, `${second}.md`), "", "utf8");

    await fs.rm(path.join(tmpDir, `${second}.md`));

    const third = await allocator.allocate();
    expect(third).toBe("T-0003");
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it("persists allocation state across separate IdAllocator instances", async () => {
    const allocatorA = new IdAllocator(tmpDir);
    await allocatorA.allocate();
    await allocatorA.allocate();

    const allocatorB = new IdAllocator(tmpDir);
    expect(await allocatorB.allocate()).toBe("T-0003");
  });

  it("never reuses an id even if the persisted state is lost but files remain", async () => {
    const allocatorA = new IdAllocator(tmpDir);
    await allocatorA.allocate();
    await allocatorA.allocate();
    await fs.writeFile(path.join(tmpDir, "T-0002.md"), "", "utf8");
    await fs.rm(path.join(tmpDir, ".id-allocator.json"));

    const allocatorB = new IdAllocator(tmpDir);
    expect(await allocatorB.allocate()).toBe("T-0003");
  });

  it("allocates unique, sequential ids under concurrent calls", async () => {
    const allocator = new IdAllocator(tmpDir);
    const ids = await Promise.all(Array.from({ length: 25 }, () => allocator.allocate()));

    expect(new Set(ids).size).toBe(25);
    const expected = Array.from({ length: 25 }, (_, i) => `T-${String(i + 1).padStart(4, "0")}`);
    expect([...ids].sort()).toEqual(expected);
  });
});
