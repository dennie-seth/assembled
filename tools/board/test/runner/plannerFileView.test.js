import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { DbTaskStore } from "../../src/lib/db/dbTaskStore.js";
import { serializeTask } from "../../src/lib/taskParser.js";
import { addWorktree } from "../../src/runner/gitOps.js";
import {
  materializePlannerFileView,
  cleanupPlannerFileView,
  diffPlannerFileView,
  applyPlannerFileViewDiff
} from "../../src/runner/plannerFileView.js";

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

function makeTask(overrides = {}) {
  return {
    id: "T-0001",
    title: "Example task",
    status: "backlog",
    priority: "P1",
    phase: 1,
    agent: null,
    depends_on: [],
    created: "2026-08-01",
    branch: null,
    commit: null,
    pr: null,
    deliverable_type: "code",
    attempts: 0,
    comments: [],
    attachments: [],
    body: "## Context\n...\n",
    ...overrides
  };
}

let tmpDir;
let repoRoot;
let store;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-plannerfileview-"));
  repoRoot = path.join(tmpDir, "repo");
  await fs.mkdir(repoRoot, { recursive: true });
  await git(["init", "-b", "main"], repoRoot);
  await git(["config", "user.email", "test@example.com"], repoRoot);
  await git(["config", "user.name", "Test"], repoRoot);

  // Simulate the Phase 2 dual-track window: tasks/ still has real, git-tracked content
  // checked out from develop (fs-mode's legacy data), even though this run is in db mode.
  await fs.mkdir(path.join(repoRoot, "tasks"), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, "tasks", "T-0001.md"),
    serializeTask(makeTask({ title: "Stale fs-mode content" })),
    "utf8"
  );
  await git(["add", "-A"], repoRoot);
  await git(["commit", "-m", "initial"], repoRoot);
  await git(["branch", "develop"], repoRoot);

  store = new DbTaskStore(":memory:");
  await store.create(makeTask({ id: "T-0001", title: "From the DB", agent: "infra" }));
  await store.create(makeTask({ id: "T-0002", title: "Second card", agent: "server" }));
});

afterEach(async () => {
  store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("materializePlannerFileView", () => {
  it("exports the full backlog from the DB, overwriting whatever tasks/ had checked out from git", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0001");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0001", baseBranch: "develop" });

    const { tasksDir, before } = await materializePlannerFileView({ store, worktreeDir });

    expect(before.size).toBe(2);
    const raw = await fs.readFile(path.join(tasksDir, "T-0001.md"), "utf8");
    expect(raw).toContain("From the DB");
    expect(raw).not.toContain("Stale fs-mode content");
    const secondRaw = await fs.readFile(path.join(tasksDir, "T-0002.md"), "utf8");
    expect(secondRaw).toContain("Second card");
  });

  it("keeps the materialized tasks/ directory invisible to git status", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0002");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0002", baseBranch: "develop" });

    await materializePlannerFileView({ store, worktreeDir });

    const { stdout } = await git(["status", "--porcelain"], worktreeDir);
    expect(stdout.trim()).toBe("");
  });

  it("does not let a git add -A / commit (the planner's own workflow step) pick up any materialized tasks/ content", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0003");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0003", baseBranch: "develop" });
    const { stdout: beforeHead } = await git(["rev-parse", "HEAD"], worktreeDir);

    await materializePlannerFileView({ store, worktreeDir });
    // Simulate the planner's documented workflow step: "git add -A && git commit".
    await git(["add", "-A"], worktreeDir);
    const { stdout: staged } = await git(["status", "--porcelain"], worktreeDir);
    expect(staged.trim()).toBe("");
    await git(["commit", "--allow-empty", "-m", "planner: expand spec"], worktreeDir);

    const { stdout: diff } = await git(["diff", `${beforeHead.trim()}..HEAD`, "--name-only"], worktreeDir);
    expect(diff.trim()).toBe("");
  });

  it("works against a plain (non-git) directory -- best-effort git steps never throw", async () => {
    const worktreeDir = path.join(tmpDir, "not-a-repo");
    await fs.mkdir(worktreeDir, { recursive: true });

    const { tasksDir } = await materializePlannerFileView({ store, worktreeDir });
    const raw = await fs.readFile(path.join(tasksDir, "T-0001.md"), "utf8");
    expect(raw).toContain("From the DB");
  });
});

describe("cleanupPlannerFileView", () => {
  it("restores originally-tracked card content and removes scratch (untracked) files, leaving git status clean", async () => {
    const worktreeDir = path.join(tmpDir, "worktrees", "T-0004");
    await addWorktree({ repoRoot, worktreeDir, branch: "feature/T-0004", baseBranch: "develop" });
    const { hiddenPaths } = await materializePlannerFileView({ store, worktreeDir });

    await cleanupPlannerFileView({ worktreeDir, hiddenPaths });

    const restored = await fs.readFile(path.join(worktreeDir, "tasks", "T-0001.md"), "utf8");
    expect(restored).toContain("Stale fs-mode content");
    await expect(fs.stat(path.join(worktreeDir, "tasks", "T-0002.md"))).rejects.toThrow();
    const { stdout } = await git(["status", "--porcelain"], worktreeDir);
    expect(stdout.trim()).toBe("");
  });

  it("falls back to a plain recursive delete for a non-git worktreeDir", async () => {
    const worktreeDir = path.join(tmpDir, "not-a-repo-2");
    await fs.mkdir(worktreeDir, { recursive: true });
    const { hiddenPaths } = await materializePlannerFileView({ store, worktreeDir });

    await cleanupPlannerFileView({ worktreeDir, hiddenPaths });

    await expect(fs.stat(path.join(worktreeDir, "tasks"))).rejects.toThrow();
  });
});

describe("diffPlannerFileView + applyPlannerFileViewDiff", () => {
  async function setupWorktree(name) {
    const worktreeDir = path.join(tmpDir, "worktrees", name);
    await addWorktree({ repoRoot, worktreeDir, branch: `feature/${name}`, baseBranch: "develop" });
    const fileView = await materializePlannerFileView({ store, worktreeDir });
    return { worktreeDir, ...fileView };
  }

  it("detects a field edit on an existing card as an update patch", async () => {
    const { worktreeDir, tasksDir, before, hiddenPaths } = await setupWorktree("T-0010");
    const raw = await fs.readFile(path.join(tasksDir, "T-0001.md"), "utf8");
    await fs.writeFile(path.join(tasksDir, "T-0001.md"), raw.replace('agent: "infra"', 'agent: "server"'), "utf8");

    const plan = await diffPlannerFileView({ tasksDir, before });
    expect(plan.ok).toBe(true);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([{ id: "T-0001", patch: { agent: "server" } }]);

    const { updatedIds, createdIds } = await applyPlannerFileViewDiff({ store, plan });
    expect(updatedIds).toEqual(["T-0001"]);
    expect(createdIds).toEqual([]);
    expect(await store.get("T-0001")).toMatchObject({ agent: "server" });

    await cleanupPlannerFileView({ worktreeDir, hiddenPaths });
    const { stdout } = await git(["status", "--porcelain"], worktreeDir);
    expect(stdout.trim()).toBe("");
  });

  // AP-7 (docs/board-invariants.md §10), db-mode half. The fs-mode counterpart lives in
  // plannerDiffGuard.test.js; here the enforcement is the MUTABLE_FIELDS allowlist.
  it("applies a planner run ADDING the approval gate -- flagging a direction card is spec work", async () => {
    const { tasksDir, before } = await setupWorktree("T-0014");
    const raw = await fs.readFile(path.join(tasksDir, "T-0001.md"), "utf8");
    await fs.writeFile(
      path.join(tasksDir, "T-0001.md"),
      raw.replace("requires_approval: false", "requires_approval: true"),
      "utf8"
    );

    const plan = await diffPlannerFileView({ tasksDir, before });
    expect(plan.ok).toBe(true);
    expect(plan.updates).toEqual([{ id: "T-0001", patch: { requires_approval: true } }]);

    await applyPlannerFileViewDiff({ store, plan });
    expect(await store.get("T-0001")).toMatchObject({ requires_approval: true });
  });

  it("rejects a planner run that forges an approval record, and applies nothing", async () => {
    const { tasksDir, before } = await setupWorktree("T-0015");
    const raw = await fs.readFile(path.join(tasksDir, "T-0001.md"), "utf8");
    await fs.writeFile(
      path.join(tasksDir, "T-0001.md"),
      raw
        .replace("approved_by: null", 'approved_by: "DennieSeth"')
        .replace("approved_at: null", 'approved_at: "2026-08-30T00:00:00.000Z"'),
      "utf8"
    );

    const plan = await diffPlannerFileView({ tasksDir, before });
    expect(plan.ok).toBe(false);
    expect(plan.violations.map((v) => v.message).join(" ")).toMatch(/approved_by/);
    expect(await store.get("T-0001")).toMatchObject({ approved_by: null, approved_at: null });
  });

  it("detects a new card file as a create", async () => {
    const { tasksDir, before } = await setupWorktree("T-0011");
    await fs.writeFile(
      path.join(tasksDir, "T-0003.md"),
      serializeTask(makeTask({ id: "T-0003", title: "Split off card" })),
      "utf8"
    );

    const plan = await diffPlannerFileView({ tasksDir, before });
    expect(plan.ok).toBe(true);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]).toMatchObject({ id: "T-0003", title: "Split off card" });

    const { createdIds } = await applyPlannerFileViewDiff({ store, plan });
    expect(createdIds).toEqual(["T-0003"]);
    expect(await store.get("T-0003")).toMatchObject({ title: "Split off card" });
  });

  it("returns no changes when the planner didn't touch a card", async () => {
    const { tasksDir, before } = await setupWorktree("T-0012");
    const plan = await diffPlannerFileView({ tasksDir, before });
    expect(plan.ok).toBe(true);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
  });

  it("flags a status change as a guardrail violation and applies nothing", async () => {
    const { tasksDir, before } = await setupWorktree("T-0013");
    const raw = await fs.readFile(path.join(tasksDir, "T-0001.md"), "utf8");
    await fs.writeFile(path.join(tasksDir, "T-0001.md"), raw.replace('status: "backlog"', 'status: "ready"'), "utf8");

    const plan = await diffPlannerFileView({ tasksDir, before });
    expect(plan.ok).toBe(false);
    expect(plan.violations[0].message).toMatch(/status changed/i);
    expect(await store.get("T-0001")).toMatchObject({ status: "backlog" });
  });

  it("flags a deleted card file as a guardrail violation", async () => {
    const { tasksDir, before } = await setupWorktree("T-0014");
    await fs.rm(path.join(tasksDir, "T-0002.md"));

    const plan = await diffPlannerFileView({ tasksDir, before });
    expect(plan.ok).toBe(false);
    expect(plan.violations[0].message).toMatch(/never delete/i);
    expect(await store.get("T-0002")).not.toBeNull();
  });

  it("flags a card file that fails to parse", async () => {
    const { tasksDir, before } = await setupWorktree("T-0015");
    await fs.writeFile(path.join(tasksDir, "T-0001.md"), "not valid frontmatter at all", "utf8");

    const plan = await diffPlannerFileView({ tasksDir, before });
    expect(plan.ok).toBe(false);
    expect(plan.violations[0].message).toMatch(/failed to parse/i);
  });
});
