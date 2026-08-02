import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "./atomicWrite.js";

const STATE_FILE = ".id-allocator.json";
const ID_FILE_RE = /^T-(\d{4,})\.md$/;

function formatId(n) {
  return `T-${String(n).padStart(4, "0")}`;
}

export class IdAllocator {
  constructor(dir) {
    this.dir = dir;
    this.statePath = path.join(dir, STATE_FILE);
    this._queue = Promise.resolve();
  }

  async allocate() {
    const result = this._queue.then(() => this._allocateOnce());
    this._queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async _allocateOnce() {
    await fs.mkdir(this.dir, { recursive: true });
    const [persistedMax, scannedMax] = await Promise.all([this._readMax(), this._scanMax()]);
    const next = Math.max(persistedMax, scannedMax) + 1;
    await atomicWriteFile(this.statePath, JSON.stringify({ maxId: next }));
    return formatId(next);
  }

  async _readMax() {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const data = JSON.parse(raw);
      return Number.isInteger(data.maxId) ? data.maxId : 0;
    } catch (err) {
      if (err.code === "ENOENT") return 0;
      throw err;
    }
  }

  async _scanMax() {
    let entries;
    try {
      entries = await fs.readdir(this.dir);
    } catch (err) {
      if (err.code === "ENOENT") return 0;
      throw err;
    }
    let max = 0;
    for (const entry of entries) {
      const match = ID_FILE_RE.exec(entry);
      if (match) {
        max = Math.max(max, Number.parseInt(match[1], 10));
      }
    }
    return max;
  }
}
