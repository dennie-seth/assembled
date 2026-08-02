export class UnmetDependencyError extends Error {
  constructor(taskId, unmetIds) {
    super(`Cannot move ${taskId} to in-progress: unmet dependencies ${unmetIds.join(", ")}`);
    this.name = "UnmetDependencyError";
    this.taskId = taskId;
    this.unmetIds = unmetIds;
  }
}

export class DependencyCycleError extends Error {
  constructor(cycleIds) {
    super(`Dependency cycle detected: ${cycleIds.join(" -> ")}`);
    this.name = "DependencyCycleError";
    this.cycleIds = cycleIds;
  }
}

async function assertNoCycle(store, startId) {
  const visited = new Set();
  const stack = [];

  async function visit(id) {
    const stackIndex = stack.indexOf(id);
    if (stackIndex !== -1) {
      throw new DependencyCycleError([...stack.slice(stackIndex), id]);
    }
    if (visited.has(id)) return;
    visited.add(id);
    stack.push(id);
    const task = await store.get(id);
    if (task) {
      for (const depId of task.depends_on) {
        await visit(depId);
      }
    }
    stack.pop();
  }

  await visit(startId);
}

export async function assertCanMoveToInProgress(store, taskId) {
  await assertNoCycle(store, taskId);

  const task = await store.get(taskId);
  if (!task) return;

  const unmetIds = [];
  for (const depId of task.depends_on) {
    const dep = await store.get(depId);
    if (!dep || dep.status !== "done") {
      unmetIds.push(depId);
    }
  }
  if (unmetIds.length > 0) {
    throw new UnmetDependencyError(taskId, unmetIds);
  }
}
