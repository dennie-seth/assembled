import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTask } from "./taskParser.js";
import { assertNoCycle, DependencyCycleError } from "./dependencyGuard.js";

export const DEFAULT_TASKS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tasks"
);

/** Reads every `*.md` file in `dir` into {file, raw} entries for validateBacklog. */
export async function readBacklogEntries(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const entries = [];
  for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
    const raw = await fs.readFile(path.join(dir, name), "utf8");
    entries.push({ file: name, raw });
  }
  return entries;
}

function parseAll(entries) {
  const tasks = [];
  const errors = [];
  for (const { file, raw } of entries) {
    try {
      tasks.push({ file, task: parseTask(raw) });
    } catch (err) {
      errors.push({ file, message: err.message });
    }
  }
  return { tasks, errors };
}

function checkFilenameMatchesId(tasks) {
  const errors = [];
  for (const { file, task } of tasks) {
    const expected = `${task.id}.md`;
    if (path.basename(file) !== expected) {
      errors.push({ file, message: `Filename does not match task id: expected "${expected}"` });
    }
  }
  return errors;
}

function checkUniqueIds(tasks) {
  const errors = [];
  const seenIn = new Map();
  for (const { file, task } of tasks) {
    const firstFile = seenIn.get(task.id);
    if (firstFile) {
      errors.push({ file, message: `Duplicate task id "${task.id}" (also used by ${firstFile})` });
    } else {
      seenIn.set(task.id, file);
    }
  }
  return errors;
}

function checkDependsOnResolve(tasks) {
  const errors = [];
  const knownIds = new Set(tasks.map(({ task }) => task.id));
  for (const { file, task } of tasks) {
    for (const dep of task.depends_on) {
      if (!knownIds.has(dep)) {
        errors.push({ file, message: `depends_on references unknown task "${dep}" -- does not resolve to any card in the backlog` });
      }
    }
  }
  return errors;
}

async function checkAcyclic(tasks) {
  const errors = [];
  const byId = new Map(tasks.map(({ task }) => [task.id, task]));
  const store = { get: async (id) => byId.get(id) ?? null };
  const reportedCycles = new Set();

  for (const { file, task } of tasks) {
    try {
      await assertNoCycle(store, task.id);
    } catch (err) {
      if (!(err instanceof DependencyCycleError)) throw err;
      const signature = [...new Set(err.cycleIds)].sort().join(",");
      if (!reportedCycles.has(signature)) {
        reportedCycles.add(signature);
        errors.push({ file, message: err.message });
      }
    }
  }
  return errors;
}

/**
 * Validates the whole backlog as a set -- the machine-checkable gate for
 * planner work, analogous to tests/lint/build for code. Returns a report
 * rather than throwing: {ok, errors, taskCount}. `errors` covers every file
 * independently (a malformed card never hides errors in the rest of the
 * set), duplicate/malformed ids, dangling depends_on refs, and dependency
 * cycles (direct or transitive). It deliberately does NOT check whether a
 * dependency's status is "done" -- that's a runtime concern for moving a
 * card to in-progress (dependencyGuard.assertCanMoveToInProgress), not a
 * backlog validity concern; depending on a not-yet-done card is normal.
 */
export async function validateBacklog(entries) {
  const { tasks, errors: parseErrors } = parseAll(entries);
  const errors = [
    ...parseErrors,
    ...checkFilenameMatchesId(tasks),
    ...checkUniqueIds(tasks),
    ...checkDependsOnResolve(tasks),
    ...(await checkAcyclic(tasks))
  ];
  return { ok: errors.length === 0, errors, taskCount: tasks.length };
}
