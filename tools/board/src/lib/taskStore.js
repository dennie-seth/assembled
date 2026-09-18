/**
 * Thrown by `update(id, updates, { expected })` when the record's current state no longer
 * matches every field named in `expected` -- a caller asked for a conditional write and the
 * condition didn't hold. `statusCode` lets an HTTP caller (httpApi.js) surface it as 409, the
 * same convention `runAwareTaskStore.js`'s `LiveRunTransitionError` uses.
 *
 * T-0384's vet-and-ready job is the first caller: it re-checks a card and then writes
 * `status: "ready"` on it, and without this, the re-check and the write are two separate
 * operations with a gap between them a concurrent change can land in (Codex review 2026-09-18,
 * finding 3).
 */
export class StaleWriteError extends Error {
  constructor(id, expected, actual) {
    super(
      `Refusing to update ${id}: expected ${JSON.stringify(expected)} but the record now reads ${JSON.stringify(actual)}`
    );
    this.name = "StaleWriteError";
    this.id = id;
    this.expected = expected;
    this.actual = actual;
    this.statusCode = 409;
  }
}

export class TaskStore {
  async list() {
    throw new Error("TaskStore.list is not implemented");
  }

  async get(_id) {
    throw new Error("TaskStore.get is not implemented");
  }

  async create(_task) {
    throw new Error("TaskStore.create is not implemented");
  }

  async update(_id, _updates) {
    throw new Error("TaskStore.update is not implemented");
  }

  async move(_id, _status) {
    throw new Error("TaskStore.move is not implemented");
  }

  async remove(_id) {
    throw new Error("TaskStore.remove is not implemented");
  }
}
