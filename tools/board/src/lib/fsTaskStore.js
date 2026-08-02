import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "./taskStore.js";
import { parseTask, serializeTask } from "./taskParser.js";
import { atomicWriteFile } from "./atomicWrite.js";

const DEFAULT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tasks"
);

function taskPath(dir, id) {
  return path.join(dir, `${id}.md`);
}

export class FsTaskStore extends TaskStore {
  constructor(dir = DEFAULT_DIR) {
    super();
    this.dir = dir;
  }

  async list() {
    await fs.mkdir(this.dir, { recursive: true });
    const entries = await fs.readdir(this.dir);
    const tasks = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const raw = await fs.readFile(path.join(this.dir, entry), "utf8");
      tasks.push(parseTask(raw));
    }
    tasks.sort((a, b) => a.id.localeCompare(b.id));
    return tasks;
  }

  async get(id) {
    try {
      const raw = await fs.readFile(taskPath(this.dir, id), "utf8");
      return parseTask(raw);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  async create(task) {
    await fs.mkdir(this.dir, { recursive: true });
    const filePath = taskPath(this.dir, task.id);
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      throw new Error(`Task ${task.id} already exists`);
    }
    await atomicWriteFile(filePath, serializeTask(task));
    return task;
  }

  async update(id, updates) {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Task ${id} not found`);
    }
    if (updates.id !== undefined && updates.id !== id) {
      throw new Error("Cannot change a task's id via update");
    }
    const merged = { ...existing, ...updates, id };
    await atomicWriteFile(taskPath(this.dir, id), serializeTask(merged));
    return merged;
  }

  async move(id, status) {
    return this.update(id, { status });
  }

  async remove(id) {
    try {
      await fs.unlink(taskPath(this.dir, id));
    } catch (err) {
      if (err.code === "ENOENT") {
        throw new Error(`Task ${id} not found`);
      }
      throw err;
    }
  }
}
