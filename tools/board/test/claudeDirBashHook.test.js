import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/claudeDirBashHook.js");

/**
 * T-0411: the actual `PreToolUse` hook entrypoint wired into the `claude` CLI via
 * `claudeCliRunner.js`'s `--settings` (see claudeDirBashGuard.js's header for why this is a
 * best-effort first line, not the guarantee -- claudeDirWriteGuard.js's diff-based backstop is
 * that). Reads a single JSON object on stdin (the CLI's real PreToolUse hook input shape:
 * `{ tool_name, tool_input: { command }, ... }`) and writes a JSON decision to stdout.
 *
 * Live-verified separately against the real `claude` CLI (v2.1.241) in a throwaway worktree --
 * see this card's commit history for the transcript. These tests pin the script's own I/O
 * contract in isolation, spawned as a real child process exactly as the CLI would.
 */
function runHook(input) {
  return new Promise((resolve, reject) => {
    const child = execFile("node", [SCRIPT_PATH], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err && err.killed) {
        reject(err);
        return;
      }
      resolve({ stdout, stderr, exitCode: err ? err.code : 0 });
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

describe("claudeDirBashHook.js", () => {
  it("denies a Bash command that writes under .claude/", async () => {
    const { stdout, exitCode } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "node -e \"require('fs').writeFileSync('.claude/rules/scratch.md','x')\"" }
    });
    expect(exitCode).toBe(0);
    const decision = JSON.parse(stdout);
    expect(decision.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toMatch(/\.claude/);
  });

  it("allows a Bash command that does not touch .claude/", async () => {
    const { stdout, exitCode } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "npx vitest run" }
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  it("allows a read-only Bash command mentioning .claude/", async () => {
    const { stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "git log -- .claude/agents/infra.md" }
    });
    expect(JSON.parse(stdout)).toEqual({});
  });

  it("ignores a non-Bash tool_use entirely", async () => {
    const { stdout, exitCode } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: ".claude/rules/scratch.md", content: "x" }
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  it("fails open (emits {}) on malformed stdin instead of crashing the run", async () => {
    const { stdout, exitCode } = await new Promise((resolve) => {
      const child = execFile("node", [SCRIPT_PATH], { timeout: 5000 }, (err, out) => {
        resolve({ stdout: out, exitCode: err ? err.code : 0 });
      });
      child.stdin.write("not json{{{");
      child.stdin.end();
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });
});
