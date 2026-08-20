import { describe, it, expect, vi } from "vitest";
import { hasLiveClaudeProcess, hasRecentlyGrowingRunLog, detectLiveRun } from "../../src/runner/liveRunGuard.js";

describe("hasLiveClaudeProcess", () => {
  it("returns true when pgrep finds a real headless agent invocation (claude -p ...)", async () => {
    const execFn = vi.fn().mockResolvedValue({
      stdout: "12345 claude -p --output-format stream-json --verbose --allowedTools Read Edit prompt text\n"
    });

    expect(await hasLiveClaudeProcess({ execFn })).toBe(true);
    expect(execFn).toHaveBeenCalledWith("pgrep", ["-af", "claude"]);
  });

  it("returns true for a --print invocation as well as the -p short flag", async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: "999 claude --print --output-format stream-json x\n" });

    expect(await hasLiveClaudeProcess({ execFn })).toBe(true);
  });

  it("returns false when pgrep matches only unrelated processes mentioning 'claude'", async () => {
    const execFn = vi.fn().mockResolvedValue({
      stdout: "555 vim /home/dennieseth/notes/claude-ideas.md\n666 grep -af claude\n"
    });

    expect(await hasLiveClaudeProcess({ execFn })).toBe(false);
  });

  it("returns false (not an error) when pgrep exits 1 for no matches", async () => {
    const err = new Error("no matches");
    err.code = 1;
    const execFn = vi.fn().mockRejectedValue(err);

    expect(await hasLiveClaudeProcess({ execFn })).toBe(false);
  });

  it("rejects with a descriptive error for a real pgrep failure (not just 'no matches')", async () => {
    const err = new Error("boom");
    err.code = 127;
    err.stderr = "pgrep: command not found";
    const execFn = vi.fn().mockRejectedValue(err);

    await expect(hasLiveClaudeProcess({ execFn })).rejects.toThrow(/pgrep/);
  });

  it("matches multiple candidate lines, not just the first", async () => {
    const execFn = vi.fn().mockResolvedValue({
      stdout: "111 some-other-proc claude-helper\n222 claude -p --output-format stream-json prompt\n"
    });

    expect(await hasLiveClaudeProcess({ execFn })).toBe(true);
  });

  it("without boardDirs, counts any matching claude -p process system-wide (old unscoped behavior)", async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: "614677 claude -p some unrelated repro\n" });

    expect(await hasLiveClaudeProcess({ execFn })).toBe(true);
  });

  it("with boardDirs, ignores a matching process whose cwd is outside every board dir", async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: "614677 claude -p some unrelated repro\n" });
    const readlinkFn = vi.fn().mockResolvedValue("/tmp/tmp.v4px2IfToT");

    const result = await hasLiveClaudeProcess({
      execFn,
      readlinkFn,
      boardDirs: ["/home/dennieseth/dev/assembled-board"]
    });

    expect(result).toBe(false);
    expect(readlinkFn).toHaveBeenCalledWith("/proc/614677/cwd");
  });

  it("with boardDirs, counts a matching process running from the board repo root itself", async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: "1 claude -p prompt\n" });
    const readlinkFn = vi.fn().mockResolvedValue("/home/dennieseth/dev/assembled-board");

    const result = await hasLiveClaudeProcess({
      execFn,
      readlinkFn,
      boardDirs: ["/home/dennieseth/dev/assembled-board"]
    });

    expect(result).toBe(true);
  });

  it("with boardDirs, counts a matching process running from a worktree under a board dir", async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: "1 claude -p prompt\n" });
    const readlinkFn = vi.fn().mockResolvedValue("/home/dennieseth/dev/assembled-board/worktrees/T-0210");

    const result = await hasLiveClaudeProcess({
      execFn,
      readlinkFn,
      boardDirs: ["/home/dennieseth/dev/assembled-board"]
    });

    expect(result).toBe(true);
  });

  it("with boardDirs, does not treat a board dir as a prefix match of an unrelated sibling dir", async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: "1 claude -p prompt\n" });
    const readlinkFn = vi.fn().mockResolvedValue("/home/dennieseth/dev/assembled-board-other");

    const result = await hasLiveClaudeProcess({
      execFn,
      readlinkFn,
      boardDirs: ["/home/dennieseth/dev/assembled-board"]
    });

    expect(result).toBe(false);
  });

  it("with boardDirs, drops a candidate pid whose cwd can't be read instead of counting it", async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: "614677 claude -p prompt\n" });
    const readlinkFn = vi.fn().mockRejectedValue(Object.assign(new Error("no such process"), { code: "ENOENT" }));

    const result = await hasLiveClaudeProcess({
      execFn,
      readlinkFn,
      boardDirs: ["/home/dennieseth/dev/assembled-board"]
    });

    expect(result).toBe(false);
  });

  it("with boardDirs, checks each candidate pid until one is confirmed in-scope", async () => {
    const execFn = vi.fn().mockResolvedValue({
      stdout: "111 claude -p stray\n222 claude -p real-card-run\n"
    });
    const readlinkFn = vi
      .fn()
      .mockResolvedValueOnce("/tmp/tmp.stray")
      .mockResolvedValueOnce("/home/dennieseth/dev/assembled-board/worktrees/T-0210");

    const result = await hasLiveClaudeProcess({
      execFn,
      readlinkFn,
      boardDirs: ["/home/dennieseth/dev/assembled-board"]
    });

    expect(result).toBe(true);
    expect(readlinkFn).toHaveBeenCalledTimes(2);
  });
});

describe("hasRecentlyGrowingRunLog", () => {
  it("returns true when a .jsonl file's mtime is within the recency window", async () => {
    const now = () => 1_000_000;
    const readdirFn = vi.fn().mockResolvedValue(["T-0099-2026-08-06.jsonl"]);
    const statFn = vi.fn().mockResolvedValue({ mtimeMs: 999_500 });

    const result = await hasRecentlyGrowingRunLog({
      runsDir: "/repo/tasks/.runs",
      recentMs: 2000,
      now,
      readdirFn,
      statFn
    });

    expect(result).toBe(true);
    expect(readdirFn).toHaveBeenCalledWith("/repo/tasks/.runs");
  });

  it("returns false when the newest .jsonl file's mtime is older than the recency window", async () => {
    const now = () => 1_000_000;
    const readdirFn = vi.fn().mockResolvedValue(["T-0099-old.jsonl"]);
    const statFn = vi.fn().mockResolvedValue({ mtimeMs: 900_000 });

    const result = await hasRecentlyGrowingRunLog({
      runsDir: "/repo/tasks/.runs",
      recentMs: 2000,
      now,
      readdirFn,
      statFn
    });

    expect(result).toBe(false);
  });

  it("ignores non-.jsonl entries in the runs directory", async () => {
    const now = () => 1_000_000;
    const readdirFn = vi.fn().mockResolvedValue([".gitkeep", "README.md"]);
    const statFn = vi.fn();

    const result = await hasRecentlyGrowingRunLog({ runsDir: "/repo/tasks/.runs", now, readdirFn, statFn });

    expect(result).toBe(false);
    expect(statFn).not.toHaveBeenCalled();
  });

  it("returns false (not an error) when tasks/.runs does not exist yet", async () => {
    const err = new Error("no such dir");
    err.code = "ENOENT";
    const readdirFn = vi.fn().mockRejectedValue(err);

    const result = await hasRecentlyGrowingRunLog({ runsDir: "/repo/tasks/.runs", readdirFn });

    expect(result).toBe(false);
  });

  it("rejects on a real readdir failure other than ENOENT", async () => {
    const err = new Error("permission denied");
    err.code = "EACCES";
    const readdirFn = vi.fn().mockRejectedValue(err);

    await expect(hasRecentlyGrowingRunLog({ runsDir: "/repo/tasks/.runs", readdirFn })).rejects.toThrow(
      /permission denied/
    );
  });

  it("returns true if any of several .jsonl files is recent, even if checked out of order", async () => {
    const now = () => 1_000_000;
    const readdirFn = vi.fn().mockResolvedValue(["a.jsonl", "b.jsonl", "c.jsonl"]);
    const statFn = vi
      .fn()
      .mockResolvedValueOnce({ mtimeMs: 100 })
      .mockResolvedValueOnce({ mtimeMs: 999_999 })
      .mockResolvedValueOnce({ mtimeMs: 200 });

    const result = await hasRecentlyGrowingRunLog({
      runsDir: "/repo/tasks/.runs",
      recentMs: 2000,
      now,
      readdirFn,
      statFn
    });

    expect(result).toBe(true);
  });
});

describe("detectLiveRun", () => {
  it("is live when the process check alone says so", async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: "1 claude -p x\n" });
    const readdirFn = vi.fn().mockResolvedValue([]);

    const result = await detectLiveRun({ runsDir: "/repo/tasks/.runs", execFn, readdirFn });

    expect(result).toEqual({ live: true, processLive: true, logGrowing: false });
  });

  it("is live when the log-growth check alone says so", async () => {
    const err = new Error("no matches");
    err.code = 1;
    const execFn = vi.fn().mockRejectedValue(err);
    const now = () => 1000;
    const readdirFn = vi.fn().mockResolvedValue(["x.jsonl"]);
    const statFn = vi.fn().mockResolvedValue({ mtimeMs: 999 });

    const result = await detectLiveRun({ runsDir: "/repo/tasks/.runs", execFn, readdirFn, statFn, now });

    expect(result).toEqual({ live: true, processLive: false, logGrowing: true });
  });

  it("is not live when neither signal fires", async () => {
    const err = new Error("no matches");
    err.code = 1;
    const execFn = vi.fn().mockRejectedValue(err);
    const readdirFn = vi.fn().mockResolvedValue([]);

    const result = await detectLiveRun({ runsDir: "/repo/tasks/.runs", execFn, readdirFn });

    expect(result).toEqual({ live: false, processLive: false, logGrowing: false });
  });

  it("is live when both signals fire", async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: "1 claude -p x\n" });
    const now = () => 1000;
    const readdirFn = vi.fn().mockResolvedValue(["x.jsonl"]);
    const statFn = vi.fn().mockResolvedValue({ mtimeMs: 999 });

    const result = await detectLiveRun({ runsDir: "/repo/tasks/.runs", execFn, readdirFn, statFn, now });

    expect(result).toEqual({ live: true, processLive: true, logGrowing: true });
  });
});
