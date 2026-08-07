import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateBacklog, readBacklogEntries, backlogEntriesFromTasks, DEFAULT_TASKS_DIR } from "../src/lib/backlogValidator.js";
import { parseTask } from "../src/lib/taskParser.js";
import { serializeTask } from "../src/lib/taskParser.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

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

function entry(t, { file } = {}) {
  return { file: file ?? `${t.id}.md`, raw: serializeTask(t) };
}

describe("validateBacklog", () => {
  it("passes for a small, well-formed backlog", async () => {
    const entries = [
      entry(task({ id: "T-0001", depends_on: [] })),
      entry(task({ id: "T-0002", depends_on: ["T-0001"] }))
    ];
    const report = await validateBacklog(entries);
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.taskCount).toBe(2);
  });

  it("passes for an empty backlog", async () => {
    const report = await validateBacklog([]);
    expect(report.ok).toBe(true);
    expect(report.taskCount).toBe(0);
  });

  it("reports a parse error per malformed card without aborting the rest of the set", async () => {
    const entries = [
      entry(task({ id: "T-0001" })),
      { file: "T-0002.md", raw: "---\nnot: valid\n---\nbody" }
    ];
    const report = await validateBacklog(entries);
    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].file).toBe("T-0002.md");
    expect(report.errors[0].message).toMatch(/missing required field/i);
    // the one good card was still counted/checked, not skipped because a sibling failed
    expect(report.taskCount).toBe(1);
  });

  it("reports every malformed card, not just the first", async () => {
    const entries = [
      { file: "T-0001.md", raw: "not frontmatter at all" },
      { file: "T-0002.md", raw: "---\nnot: valid\n---\nbody" }
    ];
    const report = await validateBacklog(entries);
    expect(report.errors).toHaveLength(2);
    expect(report.errors.map((e) => e.file)).toEqual(["T-0001.md", "T-0002.md"]);
  });

  it("flags a filename that doesn't match its own task id", async () => {
    const entries = [entry(task({ id: "T-0001" }), { file: "T-0002.md" })];
    const report = await validateBacklog(entries);
    expect(report.ok).toBe(false);
    expect(report.errors[0].message).toMatch(/filename/i);
    expect(report.errors[0].message).toMatch(/T-0001/);
  });

  it("flags duplicate task ids across two files", async () => {
    const entries = [
      entry(task({ id: "T-0001", title: "First" })),
      entry(task({ id: "T-0001", title: "Second" }), { file: "T-0001-dup.md" })
    ];
    const report = await validateBacklog(entries);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => /duplicate/i.test(e.message) && /T-0001/.test(e.message))).toBe(true);
  });

  it("flags a depends_on entry that doesn't resolve to any known card", async () => {
    const entries = [entry(task({ id: "T-0001", depends_on: ["T-0099"] }))];
    const report = await validateBacklog(entries);
    expect(report.ok).toBe(false);
    expect(report.errors[0].message).toMatch(/T-0099/);
    expect(report.errors[0].message).toMatch(/unknown|not found|resolve/i);
  });

  it("flags a direct two-node dependency cycle", async () => {
    const entries = [
      entry(task({ id: "T-0001", depends_on: ["T-0002"] })),
      entry(task({ id: "T-0002", depends_on: ["T-0001"] }))
    ];
    const report = await validateBacklog(entries);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => /cycle/i.test(e.message))).toBe(true);
  });

  it("flags a transitive three-node cycle without duplicating the report per node", async () => {
    const entries = [
      entry(task({ id: "T-0001", depends_on: ["T-0002"] })),
      entry(task({ id: "T-0002", depends_on: ["T-0003"] })),
      entry(task({ id: "T-0003", depends_on: ["T-0001"] }))
    ];
    const report = await validateBacklog(entries);
    const cycleErrors = report.errors.filter((e) => /cycle/i.test(e.message));
    expect(cycleErrors.length).toBe(1);
  });

  it("flags a self-dependency as a cycle", async () => {
    const entries = [entry(task({ id: "T-0001", depends_on: ["T-0001"] }))];
    const report = await validateBacklog(entries);
    expect(report.errors.some((e) => /cycle/i.test(e.message))).toBe(true);
  });

  it("does not flag a diamond dependency graph (shared dep, no cycle) as a cycle", async () => {
    const entries = [
      entry(task({ id: "T-0001", depends_on: ["T-0002", "T-0003"] })),
      entry(task({ id: "T-0002", depends_on: ["T-0004"] })),
      entry(task({ id: "T-0003", depends_on: ["T-0004"] })),
      entry(task({ id: "T-0004", depends_on: [] }))
    ];
    const report = await validateBacklog(entries);
    expect(report.ok).toBe(true);
  });

  it("does not flag a dependency on a card that is still in backlog status as any kind of error", async () => {
    // Unlike dependencyGuard's runtime "unmet dependency" check, the backlog
    // validator only checks structural validity -- depending on a not-yet-done
    // card is completely normal in a backlog and must never fail this gate.
    const entries = [
      entry(task({ id: "T-0001", depends_on: ["T-0002"] })),
      entry(task({ id: "T-0002", status: "backlog" }))
    ];
    const report = await validateBacklog(entries);
    expect(report.ok).toBe(true);
  });

  it("collects unrelated errors together in one report", async () => {
    const entries = [
      entry(task({ id: "T-0001", depends_on: ["T-0099"] })),
      entry(task({ id: "T-0002", depends_on: ["T-0003"] })),
      entry(task({ id: "T-0003", depends_on: ["T-0002"] }))
    ];
    const report = await validateBacklog(entries);
    expect(report.ok).toBe(false);
    expect(report.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("readBacklogEntries", () => {
  it("returns an empty array for a directory that does not exist", async () => {
    expect(await readBacklogEntries(path.join(REPO_ROOT, "tasks", "does-not-exist"))).toEqual([]);
  });

  it("reads only .md files from the real repo tasks/ directory", async () => {
    const entries = await readBacklogEntries(DEFAULT_TASKS_DIR);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.file).toMatch(/\.md$/);
      expect(typeof e.raw).toBe("string");
    }
  });
});

describe("validateBacklog against the real repo backlog", () => {
  it("passes on the current tasks/ directory as committed", async () => {
    const entries = await readBacklogEntries(DEFAULT_TASKS_DIR);
    const report = await validateBacklog(entries);
    if (!report.ok) {
      console.error("Real backlog validation errors:", report.errors);
    }
    expect(report.ok).toBe(true);
  });
});

describe("backlogEntriesFromTasks (db-mode entrypoint, see scripts/validateBacklog.js)", () => {
  it("builds the same {file, raw} shape readBacklogEntries produces off disk", () => {
    const tasks = [task({ id: "T-0001" }), task({ id: "T-0002", depends_on: ["T-0001"] })];
    const entries = backlogEntriesFromTasks(tasks);
    expect(entries).toEqual([
      { file: "T-0001.md", raw: expect.any(String) },
      { file: "T-0002.md", raw: expect.any(String) }
    ]);
    expect(parseTask(entries[0].raw)).toMatchObject({ id: "T-0001" });
  });

  it("passes validateBacklog the same way a real tasks/ directory would", async () => {
    const tasks = [task({ id: "T-0001" }), task({ id: "T-0002", depends_on: ["T-0001"] })];
    const report = await validateBacklog(backlogEntriesFromTasks(tasks));
    expect(report.ok).toBe(true);
    expect(report.taskCount).toBe(2);
  });

  it("the synthesized filename always matches the task id, so the filename-mismatch check never fires (there is no DB analog)", async () => {
    const tasks = [task({ id: "T-0003" })];
    const report = await validateBacklog(backlogEntriesFromTasks(tasks));
    expect(report.ok).toBe(true);
  });

  it("still catches a real backlog defect -- a dangling depends_on reference", async () => {
    const tasks = [task({ id: "T-0001", depends_on: ["T-9999"] })];
    const report = await validateBacklog(backlogEntriesFromTasks(tasks));
    expect(report.ok).toBe(false);
    expect(report.errors[0].message).toMatch(/does not resolve/i);
  });
});
