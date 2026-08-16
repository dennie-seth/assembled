import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../../src/lib/fsTaskStore.js";
import { IdAllocator } from "../../src/lib/idAllocator.js";
import { DbTaskStore } from "../../src/lib/db/dbTaskStore.js";
import { IdAllocatorDb } from "../../src/lib/db/idAllocatorDb.js";
import { createCard } from "../../src/runner/cardCreation.js";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

let repoRoot;
let tasksDir;
let store;
let idAllocator;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "board-cardcreation-"));
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "test@example.com"], repoRoot);
  await git(["config", "user.name", "Test"], repoRoot);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"], repoRoot);
  await git(["commit", "-m", "initial"], repoRoot);

  tasksDir = path.join(repoRoot, "tasks");
  store = new FsTaskStore(tasksDir);
  idAllocator = new IdAllocator(tasksDir);
});

afterEach(async () => {
  delete process.env.AUTO_COMMIT_CARDS_ON_CREATE;
  await fs.rm(repoRoot, { recursive: true, force: true });
});

const minimalFields = {
  title: "Auto-proposed improvement",
  status: "backlog",
  priority: "P2",
  phase: 0,
  agent: null,
  depends_on: [],
  body: "## Context\n\nsomething\n"
};

describe("createCard", () => {
  it("allocates a fresh id and writes a card the store can read back", async () => {
    const created = await createCard({ store, idAllocator, repoRoot, tasksDir, fields: minimalFields });

    expect(created.id).toMatch(/^T-\d{4}$/);
    expect(created.title).toBe(minimalFields.title);
    const reread = await store.get(created.id);
    expect(reread.title).toBe(minimalFields.title);
  });

  it("commits the new card file so it's tracked, not left untracked (same as the board's own create path)", async () => {
    const created = await createCard({ store, idAllocator, repoRoot, tasksDir, fields: minimalFields });

    const { stdout: lsFiles } = await git(["ls-files", `tasks/${created.id}.md`], repoRoot);
    expect(lsFiles.trim()).toBe(`tasks/${created.id}.md`);
    const { stdout: log } = await git(["log", "-1", "--pretty=%s"], repoRoot);
    expect(log.trim()).toContain(created.id);
  });

  it("does not commit when AUTO_COMMIT_CARDS_ON_CREATE is disabled", async () => {
    process.env.AUTO_COMMIT_CARDS_ON_CREATE = "false";
    const created = await createCard({ store, idAllocator, repoRoot, tasksDir, fields: minimalFields });

    const { stdout: lsFiles } = await git(["ls-files", `tasks/${created.id}.md`], repoRoot);
    expect(lsFiles.trim()).toBe("");
  });

  it("still returns the created card even if committing fails", async () => {
    await fs.rename(path.join(repoRoot, ".git"), path.join(repoRoot, ".git.disabled"));
    const logger = { warn: vi.fn(), error: vi.fn() };

    const created = await createCard({ store, idAllocator, repoRoot, tasksDir, fields: minimalFields, logger });

    expect(created.id).toMatch(/^T-\d{4}$/);
    const onDisk = await fs.readFile(path.join(tasksDir, `${created.id}.md`), "utf8");
    expect(onDisk).toContain(minimalFields.title);
    expect(logger.warn).toHaveBeenCalled();

    await fs.rename(path.join(repoRoot, ".git.disabled"), path.join(repoRoot, ".git"));
  });

  it("defaults optional fields the same way the board's HTTP create path does", async () => {
    const created = await createCard({
      store,
      idAllocator,
      repoRoot,
      tasksDir,
      fields: { title: "Bare minimum", phase: 0 }
    });

    expect(created.status).toBe("backlog");
    expect(created.priority).toBe("P2");
    expect(created.agent).toBe("generic");
    expect(created.depends_on).toEqual([]);
  });
});

describe("createCard in db mode", () => {
  let dbStore;
  let dbIdAllocator;

  beforeEach(() => {
    dbStore = new DbTaskStore(":memory:");
    dbIdAllocator = new IdAllocatorDb(dbStore.db);
  });

  afterEach(() => {
    dbStore.close();
  });

  it("never commits to git, even when repoRoot/tasksDir point at a real repo", async () => {
    const created = await createCard({
      store: dbStore,
      idAllocator: dbIdAllocator,
      repoRoot,
      tasksDir,
      fields: minimalFields,
      taskStoreKind: "db"
    });

    expect(created.id).toMatch(/^T-\d{4}$/);
    expect(await dbStore.get(created.id)).toMatchObject({ title: minimalFields.title });
    const { stdout: log } = await git(["log", "--oneline"], repoRoot);
    // Only the "initial" commit from beforeEach -- createCard added nothing to git.
    expect(log.trim().split("\n")).toHaveLength(1);
    const { stdout: status } = await git(["status", "--porcelain"], repoRoot);
    expect(status.trim()).toBe("");
  });

  it("broadcasts an 'added' event over hub instead of relying on a file watcher", async () => {
    const hub = { broadcast: vi.fn() };
    const created = await createCard({
      store: dbStore,
      idAllocator: dbIdAllocator,
      repoRoot,
      tasksDir,
      fields: minimalFields,
      taskStoreKind: "db",
      hub
    });

    expect(hub.broadcast).toHaveBeenCalledWith({ type: "added", id: created.id, task: created });
  });

  it("does not broadcast in fs mode (unchanged default behavior)", async () => {
    const hub = { broadcast: vi.fn() };
    await createCard({ store, idAllocator, repoRoot, tasksDir, fields: minimalFields, hub });

    expect(hub.broadcast).not.toHaveBeenCalled();
  });
});
