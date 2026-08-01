import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunLog, readRunLog } from "../../src/runner/runLog.js";

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-runlog-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("createRunLog", () => {
  it("creates a file named tasks/.runs/T-NNNN-<timestamp>.jsonl", async () => {
    const now = () => new Date("2026-08-01T12:00:00.000Z");
    const log = await createRunLog({ runsDir: tmpDir, taskId: "T-0099", now });

    expect(path.dirname(log.path)).toBe(tmpDir);
    expect(path.basename(log.path)).toMatch(/^T-0099-.+\.jsonl$/);
    await log.close();
  });

  it("creates the runs directory if it does not exist yet", async () => {
    const nested = path.join(tmpDir, ".runs");
    const log = await createRunLog({ runsDir: nested, taskId: "T-0001" });
    await log.close();

    const stat = await fs.stat(nested);
    expect(stat.isDirectory()).toBe(true);
  });

  it("appends events as NDJSON, one line per event, in order", async () => {
    const log = await createRunLog({ runsDir: tmpDir, taskId: "T-0002" });

    await log.append({ type: "system", subtype: "init" });
    await log.append({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    await log.append({ type: "result", result: "done" });
    await log.close();

    const raw = await fs.readFile(log.path, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toEqual({ type: "system", subtype: "init" });
    expect(JSON.parse(lines[2])).toEqual({ type: "result", result: "done" });
  });

  it("is append-only while open: writing the file externally does not disturb prior lines", async () => {
    const log = await createRunLog({ runsDir: tmpDir, taskId: "T-0003" });
    await log.append({ type: "a" });
    const midway = await fs.readFile(log.path, "utf8");
    expect(midway).toBe('{"type":"a"}\n');

    await log.append({ type: "b" });
    await log.close();

    const final = await fs.readFile(log.path, "utf8");
    expect(final).toBe('{"type":"a"}\n{"type":"b"}\n');
  });

  it("produces a file that is valid NDJSON end-to-end via readRunLog", async () => {
    const log = await createRunLog({ runsDir: tmpDir, taskId: "T-0004" });
    await log.append({ type: "system" });
    await log.append({ type: "result", result: "ok" });
    await log.close();

    const events = await readRunLog(log.path);
    expect(events).toEqual([{ type: "system" }, { type: "result", result: "ok" }]);
  });

  it("two runs for the same task id in the same test do not collide on filename", async () => {
    const logA = await createRunLog({ runsDir: tmpDir, taskId: "T-0005" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const logB = await createRunLog({ runsDir: tmpDir, taskId: "T-0005" });
    await logA.close();
    await logB.close();

    expect(logA.path).not.toBe(logB.path);
  });
});

describe("readRunLog", () => {
  it("returns an empty array for an empty file", async () => {
    const filePath = path.join(tmpDir, "empty.jsonl");
    await fs.writeFile(filePath, "", "utf8");
    expect(await readRunLog(filePath)).toEqual([]);
  });
});
