export const STATUSES = ["backlog", "ready", "in-progress", "validation", "review", "done", "blocked"];

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
  phase: (a, b) => a.phase - b.phase || compareIds(a.id, b.id)
};

export const SORT_KEYS = ["id", "priority", "agent", "phase"];

export function sortTasks(tasks, sortKey) {
  const compare = SORT_COMPARATORS[sortKey] ?? SORT_COMPARATORS.id;
  return [...tasks].sort(compare);
}
