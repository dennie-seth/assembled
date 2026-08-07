import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { IdAllocator } from "../src/lib/idAllocator.js";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

async function initGitRepo(dir) {
  await git(["init", "-b", "main"], dir);
  await git(["config", "user.email", "test@example.com"], dir);
  await git(["config", "user.name", "Test"], dir);
}

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

  describe("git history awareness", () => {
    it("never reuses an id that only exists in git history (committed, then deleted from the working tree)", async () => {
      const repoDir = tmpDir;
      const tasksDir = path.join(repoDir, "tasks");
      await fs.mkdir(tasksDir);
      await initGitRepo(repoDir);
      await fs.writeFile(path.join(tasksDir, "T-0005.md"), "", "utf8");
      await git(["add", "-A"], repoDir);
      await git(["commit", "-m", "add T-0005"], repoDir);
      await fs.rm(path.join(tasksDir, "T-0005.md"));
      await git(["add", "-A"], repoDir);
      await git(["commit", "-m", "remove T-0005"], repoDir);

      const allocator = new IdAllocator(tasksDir);
      expect(await allocator.allocate()).toBe("T-0006");
    });

    it("sees ids committed on other local refs/branches even when the current working tree lacks them", async () => {
      // Mirrors the real collision: a card is committed on the live board's
      // `develop` branch, but a fresh branch/worktree was cut before that
      // commit landed (or from a different ref entirely). Same repo, same
      // object store, different checked-out tree.
      const repoDir = tmpDir;
      const tasksDir = path.join(repoDir, "tasks");
      await fs.mkdir(tasksDir);
      await initGitRepo(repoDir);
      await fs.writeFile(path.join(repoDir, "README.md"), "x\n", "utf8");
      await git(["add", "-A"], repoDir);
      await git(["commit", "-m", "initial"], repoDir);

      await git(["checkout", "-b", "other"], repoDir);
      await fs.writeFile(path.join(tasksDir, "T-0009.md"), "", "utf8");
      await git(["add", "-A"], repoDir);
      await git(["commit", "-m", "add T-0009 on other branch"], repoDir);

      await git(["checkout", "main"], repoDir);
      await fs.rm(path.join(tasksDir, "T-0009.md"), { force: true });

      const allocator = new IdAllocator(tasksDir);
      expect(await allocator.allocate()).toBe("T-0010");
    });

    it("stays gap-tolerant and monotonic when combining working-tree, state-file, and git-history maxima", async () => {
      const repoDir = tmpDir;
      const tasksDir = path.join(repoDir, "tasks");
      await fs.mkdir(tasksDir);
      await initGitRepo(repoDir);
      await fs.writeFile(path.join(tasksDir, "T-0003.md"), "", "utf8");
      await git(["add", "-A"], repoDir);
      await git(["commit", "-m", "add T-0003"], repoDir);

      // Working tree only has T-0001, well below the git-history max of 3.
      await fs.rm(path.join(tasksDir, "T-0003.md"));
      await fs.writeFile(path.join(tasksDir, "T-0001.md"), "", "utf8");

      const allocator = new IdAllocator(tasksDir);
      expect(await allocator.allocate()).toBe("T-0004");
      expect(await allocator.allocate()).toBe("T-0005");
    });

    it("falls back to working-tree/state-file allocation and logs a warning when the directory is not a git repo", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await fs.writeFile(path.join(tmpDir, "T-0002.md"), "", "utf8");

      const allocator = new IdAllocator(tmpDir);
      expect(await allocator.allocate()).toBe("T-0003");
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][0]).toMatch(/git history scan unavailable/i);

      warnSpy.mockRestore();
    });
  });
});
