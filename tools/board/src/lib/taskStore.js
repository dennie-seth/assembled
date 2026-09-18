import crypto from "node:crypto";

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
 *
 * `changedFields`, added for T-0384 FIX ROUND 2 (Codex P2 #1, head d81d474c), names which of the
 * expected fields actually mismatched -- so a caller reporting a skipped write (e.g.
 * `ops/vetAndReady.js`'s apply loop) can say WHICH vetted field changed underneath it, not just
 * that "something" did.
 */
export class StaleWriteError extends Error {
  constructor(id, expected, actual, changedFields = []) {
    const fieldsNote = changedFields.length > 0 ? ` -- changed field(s): ${changedFields.join(", ")}` : "";
    super(
      `Refusing to update ${id}: expected ${JSON.stringify(expected)} but the record now reads ${JSON.stringify(actual)}${fieldsNote}`
    );
    this.name = "StaleWriteError";
    this.id = id;
    this.expected = expected;
    this.actual = actual;
    this.changedFields = changedFields;
    this.statusCode = 409;
  }
}

/** sha256 hex digest of a card body. Lets a conditional-write caller fingerprint a (potentially
 * large) body field without putting the literal content in an HTTP header or an `expected` map.
 */
export function hashBody(body) {
  return crypto.createHash("sha256").update(body ?? "", "utf8").digest("hex");
}

/** Array-aware value equality -- `expected`'s values always arrive via a fresh read (a JSON
 * round-trip over HTTP, or a separate store read), so a field like `depends_on` never has the
 * same array reference as the one on the current record even when its contents are identical.
 */
function valuesEqual(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  return a === b;
}

/**
 * Every key in `expected` that no longer matches `task`, checked against the fields a
 * conditional-write caller actually cares about -- not just `status`. A `bodyHash` key is a
 * special case: it's compared against a freshly computed `hashBody(task.body)`, since the body
 * itself is never put in `expected` (see `hashBody` above). Returns `body` (not `bodyHash`) in
 * the mismatch list, since that's the field a human reading the report needs to know changed.
 *
 * T-0384 FIX ROUND 2 (Codex P2 #1, head d81d474c): before this, both stores' conditional-write
 * check only ever compared `status` (the only field `ops/vetAndReady.js` sent), so a concurrent
 * change to body/agent/deliverable_type/depends_on that left status alone was invisible to it --
 * a card could be "readied" over a Held marker a human had just written. This is the shared
 * primitive both FsTaskStore and DbTaskStore now use so a fingerprint covering every vetted field
 * is checked atomically alongside the write, wherever `expected` is honoured at all.
 */
export function findMismatchedExpectedFields(expected, task) {
  if (!expected) return [];
  const mismatches = [];
  for (const [key, value] of Object.entries(expected)) {
    if (key === "bodyHash") {
      if (hashBody(task.body) !== value) mismatches.push("body");
    } else if (!valuesEqual(task[key], value)) {
      mismatches.push(key);
    }
  }
  return mismatches;
}

/** True when every field named in `expected` still matches `task` (see findMismatchedExpectedFields). */
export function expectedConditionHolds(expected, task) {
  return findMismatchedExpectedFields(expected, task).length === 0;
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
