#!/usr/bin/env node
import { commandTargetsClaudeDirWrite } from "../src/runner/claudeDirBashGuard.js";

/**
 * T-0411: a `PreToolUse` hook, wired into the `claude` CLI via `claudeCliRunner.js`'s
 * `--settings`, denying any `Bash` tool_use whose command appears to write under `.claude/` --
 * the CLI's own sensitive-file protection only covers Edit/Write (T-0374), and a Bash call with no
 * equivalent check is exactly how T-0408 attempt 3 rewrote `.claude/agents/planner.md` and
 * `.claude/rules/planner.md`.
 *
 * Reads one JSON object from stdin (the CLI's PreToolUse hook input:
 * `{ tool_name, tool_input: { command }, ... }`) and writes the decision to stdout. Fails open --
 * an unrecognized tool, a non-Bash call, or malformed stdin all emit `{}` (no opinion) rather than
 * crashing the run. This is a best-effort first line, not the guarantee: `claudeDirWriteGuard.js`'s
 * diff-based backstop is what actually closes the gap for anything this heuristic can't see.
 */

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function denyDecision(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  };
}

async function main() {
  const raw = await readStdin();

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  if (!input || input.tool_name !== "Bash") {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  if (!commandTargetsClaudeDirWrite(command)) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  process.stdout.write(
    JSON.stringify(
      denyDecision(
        "Denied by the board's claudeDirBashHook (T-0411): this Bash command appears to write " +
          "under .claude/. Edit/Write is refused there by the CLI's own sensitive-file " +
          "protection; Bash is refused the same way here, or it's an open bypass (see T-0408)."
      )
    )
  );
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}));
});
