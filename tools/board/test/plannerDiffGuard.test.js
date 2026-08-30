import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { checkPlannerDiffGuard, collectTasksDiff, isCardFile } from "../src/lib/plannerDiffGuard.js";
import { serializeTask } from "../src/lib/taskParser.js";

const execFileAsync = promisify(execFile);

function task(overrides = {}) {
  return {
    id: "T-0001",
    title: "Task",
    status: "backlog",
    priority: "P1",
    phase: 1,
    agent: null,
    depends_on: [],
    created: "2026-07-31",
    branch: null,
    commit: null,
    body: "## Context\n...\n\n## Acceptance\n- [ ] ...\n",
    ...overrides
  };
}

describe("isCardFile", () => {
  it("matches a top-level tasks/*.md file", () => {
    expect(isCardFile("tasks/T-0001.md")).toBe(true);
  });

  it("does not match nested paths under tasks/ (e.g. .runs/ logs)", () => {
    expect(isCardFile("tasks/.runs/T-0001/log.ndjson")).toBe(false);
  });

  it("does not match non-tasks paths", () => {
    expect(isCardFile("tools/board/src/lib/taskParser.js")).toBe(false);
  });
});

describe("checkPlannerDiffGuard", () => {
  it("catches a status flip on an existing card", () => {
    const oldRaw = serializeTask(task({ id: "T-0001", status: "backlog" }));
    const newRaw = serializeTask(task({ id: "T-0001", status: "done" }));
    const report = checkPlannerDiffGuard([{ file: "tasks/T-0001.md", status: "modified", oldRaw, newRaw }]);

    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].file).toBe("tasks/T-0001.md");
    expect(report.violations[0].message).toMatch(/status/i);
    expect(report.violations[0].message).toMatch(/backlog/);
    expect(report.violations[0].message).toMatch(/done/);
  });

  // AP-7 (docs/board-invariants.md §10): the approval record says a *human* signed off on a
  // card's direction, and downstream cards unblock on it. A planner run writing one would be
  // forging exactly that signal, so the guard treats it like a status flip.
  it("catches a planner run forging an approval record", () => {
    const oldRaw = serializeTask(task({ id: "T-0001", requires_approval: true }));
    const newRaw = serializeTask(
      task({
        id: "T-0001",
        requires_approval: true,
        approved_by: "DennieSeth",
        approved_at: "2026-08-30T00:00:00.000Z"
      })
    );
    const report = checkPlannerDiffGuard([{ file: "tasks/T-0001.md", status: "modified", oldRaw, newRaw }]);

    expect(report.ok).toBe(false);
    const messages = report.violations.map((v) => v.message).join(" ");
    expect(messages).toMatch(/approved_by/);
    expect(messages).toMatch(/approved_at/);
    expect(messages).toMatch(/only when a human approves/i);
  });

  it("catches a planner run erasing an existing approval record", () => {
    const oldRaw = serializeTask(
      task({
        id: "T-0001",
        requires_approval: true,
        approved_by: "DennieSeth",
        approved_at: "2026-08-30T00:00:00.000Z"
      })
    );
    const newRaw = serializeTask(task({ id: "T-0001", requires_approval: true }));
    const report = checkPlannerDiffGuard([{ file: "tasks/T-0001.md", status: "modified", oldRaw, newRaw }]);

    expect(report.ok).toBe(false);
  });

  it("allows a planner run to ADD the approval gate -- flagging a direction card is spec work", () => {
    const oldRaw = serializeTask(task({ id: "T-0001" }));
    const newRaw = serializeTask(task({ id: "T-0001", requires_approval: true }));
    const report = checkPlannerDiffGuard([{ file: "tasks/T-0001.md", status: "modified", oldRaw, newRaw }]);

    expect(report.ok).toBe(true);
  });

  it("catches a card file deletion", () => {
    const report = checkPlannerDiffGuard([{ file: "tasks/T-0001.md", status: "deleted" }]);

    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].file).toBe("tasks/T-0001.md");
    expect(report.violations[0].message).toMatch(/delet/i);
  });

  it("passes legitimate planner edits: new cards, and body/priority/phase/agent/depends_on changes with status untouched", () => {
    const oldRaw = serializeTask(
      task({ id: "T-0002", priority: "P2", phase: 1, agent: null, depends_on: [], body: "## Context\nold\n\n## Acceptance\n- [ ] old\n" })
    );
    const newRaw = serializeTask(
      task({
        id: "T-0002",
        priority: "P0",
        phase: 2,
        agent: "server",
        depends_on: ["T-0001"],
        body: "## Context\nrewritten per docs/PLAN.md §5\n\n## Acceptance\n- [ ] tightened\n"
      })
    );
    const newCardRaw = serializeTask(task({ id: "T-0003", status: "backlog" }));

    const report = checkPlannerDiffGuard([
      { file: "tasks/T-0002.md", status: "modified", oldRaw, newRaw },
      { file: "tasks/T-0003.md", status: "added", newRaw: newCardRaw }
    ]);

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("passes a split: original card retired in-body (status/file untouched) plus new cards for the pieces", () => {
    const oldRaw = serializeTask(task({ id: "T-0001", status: "backlog", body: "## Context\nbig\n\n## Acceptance\n- [ ] a\n- [ ] b\n" }));
    const newRaw = serializeTask(
      task({
        id: "T-0001",
        status: "backlog",
        body: "## Context\nSplit into T-0010, T-0011 per docs/PLAN.md §5.\n\n## Acceptance\n- [ ] a\n- [ ] b\n"
      })
    );
    const pieceOneRaw = serializeTask(task({ id: "T-0010", status: "backlog" }));
    const pieceTwoRaw = serializeTask(task({ id: "T-0011", status: "backlog" }));

    const report = checkPlannerDiffGuard([
      { file: "tasks/T-0001.md", status: "modified", oldRaw, newRaw },
      { file: "tasks/T-0010.md", status: "added", newRaw: pieceOneRaw },
      { file: "tasks/T-0011.md", status: "added", newRaw: pieceTwoRaw }
    ]);

    expect(report.ok).toBe(true);
  });

  it("ignores changes outside tasks/*.md (e.g. tools/board/** in a mixed diff)", () => {
    const report = checkPlannerDiffGuard([{ file: "tools/board/src/lib/fsTaskStore.js", status: "deleted" }]);
    expect(report.ok).toBe(true);
  });

  it("reports every violation in one pass, not just the first", () => {
    const oldRaw = serializeTask(task({ id: "T-0001", status: "backlog" }));
    const newRaw = serializeTask(task({ id: "T-0001", status: "review" }));
    const report = checkPlannerDiffGuard([
      { file: "tasks/T-0001.md", status: "modified", oldRaw, newRaw },
      { file: "tasks/T-0002.md", status: "deleted" }
    ]);

    expect(report.violations).toHaveLength(2);
  });

  it("does not crash and defers to the backlog validator when a card fails to parse on either side", () => {
    const report = checkPlannerDiffGuard([
      { file: "tasks/T-0001.md", status: "modified", oldRaw: "not frontmatter", newRaw: "also not frontmatter" }
    ]);
    expect(report.ok).toBe(true);
  });

  it("returns ok for an empty change set", () => {
    expect(checkPlannerDiffGuard([])).toEqual({ ok: true, violations: [] });
  });
});

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd });
}

describe("collectTasksDiff", () => {
  let tmpDir;
  let repoRoot;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-diffguard-"));
    repoRoot = path.join(tmpDir, "repo");
    await fs.mkdir(path.join(repoRoot, "tasks"), { recursive: true });
    await git(["init", "-b", "main"], repoRoot);
    await git(["config", "user.email", "test@example.com"], repoRoot);
    await git(["config", "user.name", "Test"], repoRoot);

    await fs.writeFile(path.join(repoRoot, "tasks", "T-0001.md"), serializeTask(task({ id: "T-0001", status: "backlog" })), "utf8");
    await git(["add", "."], repoRoot);
    await git(["commit", "-m", "initial"], repoRoot);
    await git(["checkout", "-b", "develop"], repoRoot);
    await git(["checkout", "-b", "feature/planner-run"], repoRoot);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reports a modified card with both old and new raw content", async () => {
    await fs.writeFile(
      path.join(repoRoot, "tasks", "T-0001.md"),
      serializeTask(task({ id: "T-0001", status: "done" })),
      "utf8"
    );
    await git(["commit", "-am", "flip status"], repoRoot);

    const changes = await collectTasksDiff({ cwd: repoRoot, baseRef: "develop" });

    expect(changes).toHaveLength(1);
    expect(changes[0].file).toBe("tasks/T-0001.md");
    expect(changes[0].status).toBe("modified");
    expect(changes[0].oldRaw).toContain('status: "backlog"');
    expect(changes[0].newRaw).toContain('status: "done"');
  });

  it("reports a deleted card with only old raw content", async () => {
    await fs.rm(path.join(repoRoot, "tasks", "T-0001.md"));
    await git(["commit", "-am", "delete card"], repoRoot);

    const changes = await collectTasksDiff({ cwd: repoRoot, baseRef: "develop" });

    expect(changes).toHaveLength(1);
    expect(changes[0].status).toBe("deleted");
    expect(changes[0].oldRaw).toContain("T-0001");
    expect(changes[0].newRaw).toBeUndefined();
  });

  it("reports an added card with only new raw content", async () => {
    await fs.writeFile(path.join(repoRoot, "tasks", "T-0002.md"), serializeTask(task({ id: "T-0002" })), "utf8");
    await git(["add", "."], repoRoot);
    await git(["commit", "-m", "add card"], repoRoot);

    const changes = await collectTasksDiff({ cwd: repoRoot, baseRef: "develop" });

    expect(changes).toHaveLength(1);
    expect(changes[0].status).toBe("added");
    expect(changes[0].oldRaw).toBeUndefined();
    expect(changes[0].newRaw).toContain("T-0002");
  });

  it("returns an empty array when tasks/ is untouched", async () => {
    const changes = await collectTasksDiff({ cwd: repoRoot, baseRef: "develop" });
    expect(changes).toEqual([]);
  });

  it("flows end-to-end into checkPlannerDiffGuard, catching a status change made on a real branch", async () => {
    await fs.writeFile(
      path.join(repoRoot, "tasks", "T-0001.md"),
      serializeTask(task({ id: "T-0001", status: "review" })),
      "utf8"
    );
    await git(["commit", "-am", "flip status"], repoRoot);

    const changes = await collectTasksDiff({ cwd: repoRoot, baseRef: "develop" });
    const report = checkPlannerDiffGuard(changes);

    expect(report.ok).toBe(false);
    expect(report.violations[0].message).toMatch(/status/i);
  });
});
