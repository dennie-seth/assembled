export const STATUSES = ["backlog", "ready", "in-progress", "review", "done", "blocked"];

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
