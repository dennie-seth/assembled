import { describe, it, expect } from "vitest";
import { commandTargetsClaudeDirWrite } from "../../src/runner/claudeDirBashGuard.js";

/**
 * T-0411: Edit/Write is refused under .claude/ by the CLI's own built-in sensitive-file check
 * (T-0374), but Bash has no equivalent built-in check -- a Bash command that writes under
 * .claude/ sails straight through, which is exactly the T-0408 exploit
 * (`node -e "require('fs').writeFileSync('.claude/rules/planner.md', ...)"`, cleaned up via
 * `git clean` since `rm` wasn't granted either).
 *
 * This is the pure heuristic a PreToolUse hook (claudeDirBashHook.js) uses to deny a Bash
 * `tool_use` before it runs. It is deliberately conservative (fail-closed: default to "denied"
 * for anything mentioning a .claude/ path that isn't recognizably read-only) because static
 * analysis of an arbitrary shell command can never be complete -- a sufficiently indirect script
 * (e.g. `node /tmp/script.js` whose own source, written by an earlier untracked call, contains
 * the write) can still slip past a command-text heuristic with no `.claude` mention in argv at
 * all. That residual gap is exactly why this card also adds a diff-based backstop
 * (claudeDirWriteGuard.js) that inspects the committed result instead of the command text -- this
 * hook is a best-effort first line, not the guarantee.
 */
describe("commandTargetsClaudeDirWrite", () => {
  it("denies the exact T-0408 exploit shape: node -e with an inline fs write under .claude/", () => {
    expect(
      commandTargetsClaudeDirWrite(
        `node -e "require('fs').writeFileSync('.claude/rules/planner.md', 'scratch')"`
      )
    ).toBe(true);
  });

  it("denies node running a script file with a .claude/ path argument", () => {
    expect(commandTargetsClaudeDirWrite("node script.js .claude/rules/planner.md")).toBe(true);
  });

  it("denies a heredoc/redirect writing into .claude/", () => {
    expect(
      commandTargetsClaudeDirWrite(`cat <<'EOF' > .claude/rules/scratch.md\nhello\nEOF`)
    ).toBe(true);
  });

  it("denies tee targeting a .claude/ path", () => {
    expect(commandTargetsClaudeDirWrite("echo hello | tee .claude/rules/scratch.md")).toBe(true);
  });

  it("denies cp/mv into .claude/", () => {
    expect(commandTargetsClaudeDirWrite("cp /tmp/scratch.md .claude/rules/scratch.md")).toBe(true);
    expect(commandTargetsClaudeDirWrite("mv /tmp/scratch.md .claude/rules/scratch.md")).toBe(true);
  });

  it("denies sed -i editing a file under .claude/", () => {
    expect(commandTargetsClaudeDirWrite("sed -i 's/x/y/' .claude/rules/conduct.md")).toBe(true);
  });

  it("denies git checkout of a path under .claude/", () => {
    expect(commandTargetsClaudeDirWrite("git checkout other-branch -- .claude/rules/planner.md")).toBe(
      true
    );
  });

  it("denies git apply of a patch touching .claude/", () => {
    expect(commandTargetsClaudeDirWrite("git apply /tmp/claude-scratch.patch")).toBe(false);
    // The patch's own target path inside .claude/ is what matters, not the patch file's own name.
    expect(commandTargetsClaudeDirWrite("git apply --include='.claude/*' /tmp/x.patch")).toBe(true);
  });

  it("denies mkdir/touch/rm/chmod under .claude/", () => {
    expect(commandTargetsClaudeDirWrite("mkdir -p .claude/agents")).toBe(true);
    expect(commandTargetsClaudeDirWrite("touch .claude/agents/scratch.md")).toBe(true);
    expect(commandTargetsClaudeDirWrite("rm .claude/rules/conduct.md")).toBe(true);
    expect(commandTargetsClaudeDirWrite("chmod 600 .claude/settings.json")).toBe(true);
  });

  it("denies a write path outside the worktree entirely -- the live board checkout, ~/.claude/", () => {
    expect(
      commandTargetsClaudeDirWrite(
        "node -e \"require('fs').writeFileSync('/home/dennieseth/dev/assembled-board/.claude/rules/scratch.md','x')\""
      )
    ).toBe(true);
    expect(commandTargetsClaudeDirWrite("echo x > ~/.claude/settings.json")).toBe(true);
  });

  it("denies a relative traversal out of the worktree into .claude/", () => {
    expect(commandTargetsClaudeDirWrite("echo x > tools/../.claude/rules/scratch.md")).toBe(true);
    expect(commandTargetsClaudeDirWrite("echo x > ../.claude/rules/scratch.md")).toBe(true);
  });

  it("allows a read-only command mentioning a .claude/ path -- grep, cat, git log/diff/show", () => {
    expect(commandTargetsClaudeDirWrite("grep -r infra .claude/agents")).toBe(false);
    expect(commandTargetsClaudeDirWrite("cat .claude/rules/conduct.md")).toBe(false);
    expect(commandTargetsClaudeDirWrite("git log -- .claude/agents/infra.md")).toBe(false);
    expect(commandTargetsClaudeDirWrite("git diff .claude/rules/js.md")).toBe(false);
    expect(commandTargetsClaudeDirWrite("git show HEAD:.claude/agents/infra.md")).toBe(false);
    expect(commandTargetsClaudeDirWrite("ls -la .claude/agents")).toBe(false);
    expect(commandTargetsClaudeDirWrite("find .claude -name '*.md'")).toBe(false);
  });

  it("does not over-match a path that only looks like the directory", () => {
    expect(commandTargetsClaudeDirWrite("echo x > my.claude/notes.md")).toBe(false);
    expect(commandTargetsClaudeDirWrite("echo x > claude/notes.md")).toBe(false);
    expect(commandTargetsClaudeDirWrite("echo x > .claude-notes/scratch.md")).toBe(false);
    expect(commandTargetsClaudeDirWrite("cat docs/notes-on-.claude.md")).toBe(false);
  });

  it("leaves ordinary Bash commands that never mention .claude/ alone -- node/npm/git keep working", () => {
    expect(commandTargetsClaudeDirWrite("node tools/board/scripts/validateBacklog.js")).toBe(false);
    expect(commandTargetsClaudeDirWrite("node -e \"console.log(1+1)\"")).toBe(false);
    expect(commandTargetsClaudeDirWrite("npx vitest run")).toBe(false);
    expect(commandTargetsClaudeDirWrite("npm test")).toBe(false);
    expect(commandTargetsClaudeDirWrite("git status")).toBe(false);
    expect(commandTargetsClaudeDirWrite("git commit -m 'feat: T-0411 thing'")).toBe(false);
  });

  it("denies a compound command where only one &&/;-joined segment targets .claude/", () => {
    expect(
      commandTargetsClaudeDirWrite("npm test && node -e \"require('fs').writeFileSync('.claude/rules/x.md','y')\"")
    ).toBe(true);
  });

  it("handles non-string/empty input without throwing", () => {
    expect(commandTargetsClaudeDirWrite("")).toBe(false);
    expect(commandTargetsClaudeDirWrite(undefined)).toBe(false);
    expect(commandTargetsClaudeDirWrite(null)).toBe(false);
  });
});
