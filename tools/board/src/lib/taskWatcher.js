import { EventEmitter } from "node:events";
import path from "node:path";
import { promises as fs } from "node:fs";
import chokidar from "chokidar";
import { parseTask } from "./taskParser.js";

export class TaskWatcher extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.watcher = null;
  }

  start() {
    this.watcher = chokidar.watch("*.md", {
      cwd: this.dir,
      ignoreInitial: true
    });
    this.watcher.on("add", (file) => this._handleUpsert(file, "added"));
    this.watcher.on("change", (file) => this._handleUpsert(file, "changed"));
    this.watcher.on("unlink", (file) => this._handleRemove(file));

    return new Promise((resolve, reject) => {
      this.watcher.once("ready", resolve);
      this.watcher.once("error", reject);
    });
  }

  async _handleUpsert(file, type) {
    const id = path.basename(file, ".md");
    try {
      const raw = await fs.readFile(path.join(this.dir, file), "utf8");
      const task = parseTask(raw);
      this.emit("task-changed", { type, id, task });
    } catch (err) {
      this.emit("error", err);
    }
  }

  _handleRemove(file) {
    const id = path.basename(file, ".md");
    this.emit("task-changed", { type: "removed", id, task: null });
  }

  async close() {
    if (this.watcher) {
      await this.watcher.close();
    }
  }
}
