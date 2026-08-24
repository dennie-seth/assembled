export const STATUSES = ["backlog", "ready", "in-progress", "validation", "review", "done", "blocked", "retired"];

export function groupTasksByStatus(tasks, statuses = STATUSES) {
  const grouped = new Map(statuses.map((status) => [status, []]));
  for (const task of tasks) {
    if (!grouped.has(task.status)) {
      grouped.set(task.status, []);
    }
    grouped.get(task.status).push(task);
  }
  return grouped;
}

export function buildStatusPatch(newStatus) {
  return { status: newStatus };
}

export const TASK_EVENT_TYPES = new Set(["added", "changed", "removed"]);

export function applyTaskEvent(tasks, event) {
  const { type, id, task } = event;
  if (type === "removed") {
    return tasks.filter((existing) => existing.id !== id);
  }
  const index = tasks.findIndex((existing) => existing.id === id);
  if (index === -1) {
    return [...tasks, task];
  }
  const next = tasks.slice();
  next[index] = task;
  return next;
}

/**
 * Per-task list of the dependency ids that are NOT yet satisfied, in the order the task
 * lists them in depends_on. An empty array means every dependency is done/retired (or the
 * task has none). Mirrors the server-side rule in src/lib/dependencyGuard.js exactly: a
 * dependency counts as met only when its status is "done" or "retired", and a dependency id
 * with no matching task counts as unmet.
 *
 * computeDependencyStatus below is derived from this, so the red/green dot and anything
 * else keyed on blocked-ness (the disabled Run control in boardView.js) share one scan and
 * one predicate -- they cannot drift apart the way two independent scans would.
 */
export function computeUnmetDependencies(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const unmet = new Map();
  for (const task of tasks) {
    unmet.set(
      task.id,
      task.depends_on.filter((depId) => {
        const dep = byId.get(depId);
        return !dep || (dep.status !== "done" && dep.status !== "retired");
      })
    );
  }
  return unmet;
}

/**
 * Single derived dependency status per task, keyed on that task's OWN depends_on:
 * "blocked" if any dependency is missing or not done/retired, otherwise "ready"
 * (including tasks with no dependencies at all). Every task gets exactly one of
 * the two values, so callers rendering a badge from this map can never end up
 * showing both a "blocked" and a "ready" indicator on the same card.
 */
export function computeDependencyStatus(tasks) {
  const status = new Map();
  for (const [id, unmetIds] of computeUnmetDependencies(tasks)) {
    status.set(id, unmetIds.length > 0 ? "blocked" : "ready");
  }
  return status;
}

/** Reverse-dependency counts: how many other tasks list each task id in their depends_on. */
export function computeBlockerCounts(tasks) {
  const counts = new Map();
  for (const task of tasks) {
    for (const depId of task.depends_on) {
      counts.set(depId, (counts.get(depId) ?? 0) + 1);
    }
  }
  return counts;
}

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

function compareIds(a, b) {
  return Number(a.slice(2)) - Number(b.slice(2));
}

const SORT_COMPARATORS = {
  id: (a, b) => compareIds(a.id, b.id),
  priority: (a, b) => (PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99) || compareIds(a.id, b.id),
  agent: (a, b) => (a.agent ?? "").localeCompare(b.agent ?? "") || compareIds(a.id, b.id),
  phase: (a, b) => a.phase - b.phase || compareIds(a.id, b.id),
  oldest: (a, b) => (a.created ?? "").localeCompare(b.created ?? "") || compareIds(a.id, b.id),
  newest: (a, b) => (b.created ?? "").localeCompare(a.created ?? "") || compareIds(a.id, b.id)
};

export const SORT_KEYS = ["id", "priority", "agent", "phase", "oldest", "newest"];

export function sortTasks(tasks, sortKey) {
  const compare = SORT_COMPARATORS[sortKey] ?? SORT_COMPARATORS.id;
  return [...tasks].sort(compare);
}
