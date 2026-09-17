import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmTemp } from "./helpers/rmTemp.js";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { startHttpServer } from "../src/server/httpApi.js";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

let repoRoot;
let tasksDir;
let server;
let baseUrl;

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-update-"));
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "test@example.com"], repoRoot);
  await git(["config", "user.name", "Test"], repoRoot);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"], repoRoot);
  await git(["commit", "-m", "initial"], repoRoot);

  tasksDir = path.join(repoRoot, "tasks");
  const store = new FsTaskStore(tasksDir);
  const idAllocator = new IdAllocator(tasksDir);
  server = await startHttpServer({ store, idAllocator, repoRoot, tasksDir, port: 0 });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  delete process.env.AUTO_COMMIT_CARDS_ON_CREATE;
  delete process.env.AUTO_PUSH_ON_COMMIT;
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(repoRoot, { recursive: true, force: true });
});

async function createTask(overrides = {}) {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Test task", phase: 1, ...overrides })
  });
  return res.json();
}

async function patchTask(id, body) {
  return fetch(`${baseUrl}/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("PATCH /api/tasks/:id — commits the card update to git", () => {
  it("leaves a clean working tree after an ordinary status update", async () => {
    const task = await createTask();

    await patchTask(task.id, { status: "ready" });

    const { stdout: status } = await git(["status", "--porcelain", "--", `tasks/${task.id}.md`], repoRoot);
    expect(status.trim()).toBe("");
  });

  it("uses a descriptive commit message referencing the card id", async () => {
    const task = await createTask();

    await patchTask(task.id, { status: "ready" });

    const { stdout: log } = await git(["log", "-1", "--pretty=%s"], repoRoot);
    expect(log.trim()).toContain(task.id);
  });

  it("commits each update as its own commit, not batched together", async () => {
    const task = await createTask();

    await patchTask(task.id, { status: "ready" });
    await patchTask(task.id, { status: "in-progress" });

    const { stdout: log } = await git(["log", "--oneline"], repoRoot);
    const lines = log.trim().split("\n");
    // initial + create-card commit + two update commits
    expect(lines.length).toBe(4);
  });

  it("does not commit when AUTO_COMMIT_CARDS_ON_CREATE is disabled", async () => {
    const task = await createTask();
    process.env.AUTO_COMMIT_CARDS_ON_CREATE = "false";

    await patchTask(task.id, { status: "ready" });

    // The card file is already tracked from createTask()'s own commit, so a skipped update
    // commit leaves it modified-but-uncommitted ("M"), not untracked ("??").
    const { stdout: status } = await git(["status", "--porcelain", "--", `tasks/${task.id}.md`], repoRoot);
    expect(status.trim()).toBe(`M tasks/${task.id}.md`);
  });

  it("still returns 200 with the updated card even if committing fails", async () => {
    const task = await createTask();
    await fs.rename(path.join(repoRoot, ".git"), path.join(repoRoot, ".git.disabled"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await patchTask(task.id, { status: "ready" });

    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.status).toBe("ready");
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    await fs.rename(path.join(repoRoot, ".git.disabled"), path.join(repoRoot, ".git"));
  });

  it("does not attempt a commit when no repoRoot is configured on the server", async () => {
    const bareDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-update-nocommit-"));
    const bareStore = new FsTaskStore(bareDir);
    const bareAllocator = new IdAllocator(bareDir);
    const bareServer = await startHttpServer({ store: bareStore, idAllocator: bareAllocator, port: 0 });
    const { port } = bareServer.address();

    const createRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No repo configured", phase: 1 })
    });
    const task = await createRes.json();

    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready" })
    });

    expect(res.status).toBe(200);
    await new Promise((resolve) => bareServer.close(resolve));
    await fs.rm(bareDir, { recursive: true, force: true });
  });

  it("lets a subsequent develop pull succeed on the Review→Done transition (the reported bug)", async () => {
    // AUTO_PUSH_ON_COMMIT is disabled here so the scenario is driven deterministically by hand
    // (real pushes/merges, no async retry chain) instead of racing the board's own background
    // auto-push. pullDevelop() defaults to branch "develop", so rename repoRoot's local branch
    // to match before wiring up origin.
    process.env.AUTO_PUSH_ON_COMMIT = "false";
    await git(["branch", "-m", "main", "develop"], repoRoot);

    const originDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-update-origin-"));
    await git(["clone", "--bare", repoRoot, originDir], repoRoot);
    await git(["remote", "add", "origin", originDir], repoRoot);
    await git(["fetch", "origin"], repoRoot);
    await git(["branch", "--set-upstream-to=origin/develop", "develop"], repoRoot);

    const task = await createTask();
    // Sync origin up to the just-created card so it matches repoRoot before either side moves on.
    await git(["push", "origin", "develop"], repoRoot);

    // A sibling clone (standing in for a different machine/session pushing to origin) advances
    // origin/develop with a commit unrelated to this card.
    const otherClone = await fs.mkdtemp(path.join(os.tmpdir(), "board-httpapi-update-otherclone-"));
    await git(["clone", originDir, otherClone], repoRoot);
    await git(["config", "user.email", "test@example.com"], otherClone);
    await git(["config", "user.name", "Test"], otherClone);
    await fs.writeFile(path.join(otherClone, "OTHER.md"), "from origin\n", "utf8");
    await git(["add", "OTHER.md"], otherClone);
    await git(["commit", "-m", "unrelated origin commit"], otherClone);
    await git(["push", "origin", "HEAD:develop"], otherClone);

    // Move the card Review -> Done on repoRoot, exactly like a drag on the live board. Before
    // the fix, each of these PATCHes left tasks/<id>.md as an uncommitted working-tree diff, so
    // by the time the Done pull ran, repoRoot's tree was dirty *and* origin had moved on -- the
    // combination `pullDevelop` used to reject with "local changes ... would be overwritten by
    // merge" on. With the fix, each PATCH commits cleanly, so repoRoot only ever diverges from
    // origin at the commit level (a clean, mergeable divergence), and the pull just succeeds.
    await patchTask(task.id, { status: "review" });
    const res = await patchTask(task.id, { status: "done" });
    expect(res.status).toBe(200);

    // Search all of history for the merged-in commit rather than a fixed-size window. The
    // property under test is "the Done pull brought origin's commit into repoRoot's history",
    // and how many commits sit above it is not part of that: the two card-update commits plus
    // the merge commit itself already push it to depth 4, so `log --oneline -3` reported a
    // failure while the merge it was checking for had demonstrably happened. That was a CI
    // flake, not a regression -- the observed failure output contained
    // "Merge branch 'develop' of /tmp/board-httpapi-update-origin-... into develop" on the
    // very line that proved the pull succeeded.
    await vi.waitFor(async () => {
      const { stdout: log } = await git(
        ["log", "--oneline", "--grep=unrelated origin commit"],
        repoRoot
      );
      expect(log).toContain("unrelated origin commit");
    });

    // Scoped to the card file itself -- the id allocator's own untracked state file
    // (tasks/.id-allocator.json) is a separate, pre-existing artifact unrelated to this fix.
    const { stdout: status } = await git(["status", "--porcelain", "--", `tasks/${task.id}.md`], repoRoot);
    expect(status.trim()).toBe("");

    await rmTemp(originDir);
    await rmTemp(otherClone);
  });
});
