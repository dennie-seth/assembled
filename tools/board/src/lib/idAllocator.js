import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicWriteFile } from "./atomicWrite.js";

const execFileAsync = promisify(execFile);

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
    const [persistedMax, scannedMax, gitMax] = await Promise.all([
      this._readMax(),
      this._scanMax(),
      this._gitScanMax()
    ]);
    const next = Math.max(persistedMax, scannedMax, gitMax) + 1;
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

  /**
   * Scans every ref in the repo (all local branches, not just the checked-out
   * one) for T-NNNN.md filenames that were ever added, renamed, or deleted --
   * closes the collision where a card committed on another branch/worktree of
   * this same repo (e.g. the live board's `develop`) is invisible to a fresh
   * branch cut from a stale point, because the working-tree/state-file scans
   * above only see what's checked out right here. Falls back to 0 (working
   * tree/state file still apply) if this directory isn't inside a git repo or
   * git isn't available -- that's expected in throwaway test fixtures.
   */
  async _gitScanMax() {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["log", "--all", "--pretty=format:", "--name-only", "--", "*.md"],
        { cwd: this.dir }
      );
      let max = 0;
      for (const line of stdout.split("\n")) {
        const match = ID_FILE_RE.exec(path.basename(line.trim()));
        if (match) {
          max = Math.max(max, Number.parseInt(match[1], 10));
        }
      }
      return max;
    } catch (err) {
      console.warn(
        `IdAllocator: git history scan unavailable (${err.message.split("\n")[0]}); ` +
          `falling back to working-tree + state-file allocation only.`
      );
      return 0;
    }
  }
}
