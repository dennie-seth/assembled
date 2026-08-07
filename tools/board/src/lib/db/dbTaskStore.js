import { TaskStore } from "../taskStore.js";
import { validateTask } from "../taskParser.js";
import { openDb, DEFAULT_DB_PATH } from "./connection.js";

const DEFAULT_ACTOR = "system";

function taskRowToTask(db, row) {
  const dependsOn = db
    .prepare("SELECT depends_on_id FROM task_dependencies WHERE task_id = ? ORDER BY rowid ASC")
    .all(row.id)
    .map((r) => r.depends_on_id);
  const comments = db
    .prepare("SELECT author, text, created_at AS timestamp FROM comments WHERE task_id = ? ORDER BY id ASC")
    .all(row.id);
  const attachments = db
    .prepare(
      "SELECT filename, size, mimetype, uploaded_by, uploaded_at FROM attachments WHERE task_id = ? ORDER BY id ASC"
    )
    .all(row.id);

  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    phase: row.phase,
    agent: row.agent,
    depends_on: dependsOn,
    created: row.created,
    branch: row.branch,
    commit: row.commit_sha,
    pr: row.pr,
    deliverable_type: row.deliverable_type,
    attempts: row.attempts,
    comments,
    attachments,
    body: row.body
  };
}

/**
 * SQLite-backed TaskStore (docs/design/cards-to-database.md, Phase 1). Implements the exact
 * same list/get/create/update/move/remove contract as FsTaskStore -- see
 * test/taskStoreContract.js, which both stores run against. Not wired into boardServer.js in
 * this phase; nothing in the live app constructs this class yet.
 *
 * Every mutating call accepts an optional trailing `{ actor }` options object (both stores
 * silently accept it -- FsTaskStore just ignores the extra argument) so a future shared call
 * site can tag card_events rows with who made the change; it defaults to "system" when omitted.
 */
export class DbTaskStore extends TaskStore {
  constructor(dbOrPath = DEFAULT_DB_PATH) {
    super();
    if (typeof dbOrPath === "string") {
      this.db = openDb(dbOrPath);
      this._ownsDb = true;
    } else {
      this.db = dbOrPath;
      this._ownsDb = false;
    }
  }

  close() {
    if (this._ownsDb) this.db.close();
  }

  async list() {
    const rows = this.db.prepare("SELECT * FROM tasks ORDER BY id ASC").all();
    return rows.map((row) => taskRowToTask(this.db, row));
  }

  async get(id) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? taskRowToTask(this.db, row) : null;
  }

  async create(task, { actor = DEFAULT_ACTOR } = {}) {
    validateTask(task);
    const db = this.db;

    const run = db.transaction(() => {
      const exists = db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(task.id);
      if (exists) {
        throw new Error(`Task ${task.id} already exists`);
      }

      db.prepare(
        `INSERT INTO tasks
           (id, title, status, priority, phase, agent, created, branch, commit_sha, pr,
            deliverable_type, attempts, body)
         VALUES (@id, @title, @status, @priority, @phase, @agent, @created, @branch, @commit_sha,
                 @pr, @deliverable_type, @attempts, @body)`
      ).run({
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        phase: task.phase,
        agent: task.agent ?? null,
        created: task.created,
        branch: task.branch ?? null,
        commit_sha: task.commit ?? null,
        pr: task.pr ?? null,
        deliverable_type: task.deliverable_type ?? "code",
        attempts: task.attempts ?? 0,
        body: task.body
      });

      this._insertDependsOn(task.id, task.depends_on ?? []);
      this._insertComments(task.id, task.comments ?? []);
      this._insertAttachments(task.id, task.attachments ?? []);
      this._recordEvent(task.id, "create", Object.keys(task).filter((k) => k !== "id"), actor);
    });

    run();
    return this.get(task.id);
  }

  async update(id, updates, { actor = DEFAULT_ACTOR } = {}) {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Task ${id} not found`);
    }
    if (updates.id !== undefined && updates.id !== id) {
      throw new Error("Cannot change a task's id via update");
    }
    const merged = { ...existing, ...updates, id };
    validateTask(merged);
    const db = this.db;
    const changedFields = Object.keys(updates).filter((k) => k !== "id");

    const run = db.transaction(() => {
      db.prepare(
        `UPDATE tasks SET
           title = @title, status = @status, priority = @priority, phase = @phase,
           agent = @agent, created = @created, branch = @branch, commit_sha = @commit_sha,
           pr = @pr, deliverable_type = @deliverable_type, attempts = @attempts, body = @body
         WHERE id = @id`
      ).run({
        id,
        title: merged.title,
        status: merged.status,
        priority: merged.priority,
        phase: merged.phase,
        agent: merged.agent ?? null,
        created: merged.created,
        branch: merged.branch ?? null,
        commit_sha: merged.commit ?? null,
        pr: merged.pr ?? null,
        deliverable_type: merged.deliverable_type ?? "code",
        attempts: merged.attempts ?? 0,
        body: merged.body
      });

      if ("depends_on" in updates) {
        db.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(id);
        this._insertDependsOn(id, merged.depends_on ?? []);
      }
      if ("comments" in updates) {
        db.prepare("DELETE FROM comments WHERE task_id = ?").run(id);
        this._insertComments(id, merged.comments ?? []);
      }
      if ("attachments" in updates) {
        db.prepare("DELETE FROM attachments WHERE task_id = ?").run(id);
        this._insertAttachments(id, merged.attachments ?? []);
      }
      if (changedFields.length > 0) {
        this._recordEvent(id, "update", changedFields, actor);
      }
    });

    run();
    return this.get(id);
  }

  async move(id, status, options = {}) {
    return this.update(id, { status }, options);
  }

  async remove(id, { actor = DEFAULT_ACTOR } = {}) {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Task ${id} not found`);
    }
    const db = this.db;
    const run = db.transaction(() => {
      db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
      this._recordEvent(id, "remove", [], actor);
    });
    run();
  }

  _insertDependsOn(taskId, dependsOn) {
    const insert = this.db.prepare(
      "INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)"
    );
    for (const depId of dependsOn) {
      insert.run(taskId, depId);
    }
  }

  _insertComments(taskId, comments) {
    const insert = this.db.prepare(
      "INSERT INTO comments (task_id, author, text, created_at) VALUES (?, ?, ?, ?)"
    );
    for (const comment of comments) {
      insert.run(taskId, comment.author, comment.text, comment.timestamp);
    }
  }

  _insertAttachments(taskId, attachments) {
    const insert = this.db.prepare(
      `INSERT INTO attachments (task_id, filename, size, mimetype, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const attachment of attachments) {
      insert.run(
        taskId,
        attachment.filename,
        attachment.size,
        attachment.mimetype,
        attachment.uploaded_by,
        attachment.uploaded_at
      );
    }
  }

  _recordEvent(taskId, action, changed, actor) {
    this.db
      .prepare(
        "INSERT INTO card_events (task_id, action, changed, actor, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(taskId, action, JSON.stringify(changed), actor, new Date().toISOString());
  }
}
