import { describe, it, expect } from "vitest";
import { commandTargetsClaudeDirWrite } from "../../src/runner/claudeDirBashGuard.js";

/**
 * T-0411: Edit/Write is refused under .claude/ by the CLI's own built-in sensitive-file check
 * (T-0374), but Bash has no equivalent built-in check -- a Bash command that writes under
 * .claude/ sails straight through, which is exactly the T-0408 exploit
 * (`node -e "require('fs').writeFileSync('.claude/rules/planner.md', ...)"`, cleaned up via
 * `git clean` since `rm` wasn't granted either).
 *
 * This is the pure(ish) heuristic a PreToolUse hook (claudeDirBashHook.js) uses to deny a Bash
 * `tool_use` before it runs. It is deliberately conservative (fail-closed: default to "denied"
 * for anything mentioning a .claude/ path that isn't recognizably read-only). Beyond matching the
 * command *text*, it also reads two narrow classes of *referenced file content* when the .claude/
 * target could only ever live there, never in argv: (1) a `git apply`/`git am`/`patch` target,
 * since the touched path lives inside the patch's own diff headers; (2) an interpreter script
 * (`node`/`python`/`bash`/...) resolving *outside* the current worktree, since that's the "temp
 * script written elsewhere and then executed" shape -- one indirection past the literal T-0408
 * exploit. An in-worktree script's content is deliberately left unread (ordinary in-repo
 * automation like `tools/board/scripts/*.js` isn't re-read on every invocation), and a write
 * routed through a symlink whose target resolves under .claude/ with no literal `.claude` mention
 * anywhere -- command text or read file content -- is still outside what static analysis can see.
 * Both remaining gaps are exactly why this card also adds a diff-based backstop
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

  it("denies git apply/am whose command text itself names a .claude/ path", () => {
    // The patch's own target path inside .claude/ is what matters, not the patch file's own name.
    expect(commandTargetsClaudeDirWrite("git apply --include='.claude/*' /tmp/x.patch")).toBe(true);
  });

  it("denies git apply of a patch file whose own diff content touches .claude/ -- the target path lives inside the referenced file, never in this command's own argv", () => {
    expect(
      commandTargetsClaudeDirWrite("git apply /tmp/claude-scratch.patch", {
        readFile: (p) =>
          p === "/tmp/claude-scratch.patch"
            ? "diff --git a/.claude/rules/x.md b/.claude/rules/x.md\n--- a/.claude/rules/x.md\n+++ b/.claude/rules/x.md\n"
            : null
      })
    ).toBe(true);
    expect(
      commandTargetsClaudeDirWrite("git am /tmp/claude-scratch.mbox", {
        readFile: (p) =>
          p === "/tmp/claude-scratch.mbox" ? "diff --git a/.claude/agents/infra.md b/.claude/agents/infra.md\n" : null
      })
    ).toBe(true);
  });

  it("allows git apply of a patch file whose content provably never touches .claude/", () => {
    expect(
      commandTargetsClaudeDirWrite("git apply /tmp/harmless.patch", {
        readFile: (p) => (p === "/tmp/harmless.patch" ? "diff --git a/README.md b/README.md\n" : null)
      })
    ).toBe(false);
  });

  it("fails closed on git apply/patch when the referenced file can't be read/verified -- a write-capable verb with an unknown target is treated as risky, not assumed safe", () => {
    expect(commandTargetsClaudeDirWrite("git apply /tmp/t0411-does-not-exist.patch")).toBe(true);
    expect(commandTargetsClaudeDirWrite("patch -p1 -i /tmp/t0411-does-not-exist.patch")).toBe(true);
  });

  it("denies the patch utility the same way, including reading its target off a redirect", () => {
    expect(
      commandTargetsClaudeDirWrite("patch -p1 < /tmp/claude-scratch.patch", {
        readFile: (p) => (p === "/tmp/claude-scratch.patch" ? "+++ b/.claude/rules/x.md\n" : null)
      })
    ).toBe(true);
  });

  it("denies a temp script outside the worktree whose own content writes under .claude/ -- the exact residual gap this card's design doc calls out (T-0408's shape, one indirection further)", () => {
    expect(
      commandTargetsClaudeDirWrite("node /tmp/scratch-1234.js", {
        cwd: "/home/example/worktree",
        readFile: (p) =>
          p === "/tmp/scratch-1234.js" ? "require('fs').writeFileSync('.claude/rules/x.md', 'y')" : null
      })
    ).toBe(true);
  });

  it("does not flag an outside-worktree interpreter script whose content never mentions .claude/", () => {
    expect(
      commandTargetsClaudeDirWrite("node /tmp/harmless.js", {
        cwd: "/home/example/worktree",
        readFile: (p) => (p === "/tmp/harmless.js" ? "console.log('hi')" : null)
      })
    ).toBe(false);
  });

  it("does not fail closed on an interpreter script that can't be read -- ordinary tooling isn't punished for an unreadable/nonexistent path", () => {
    expect(
      commandTargetsClaudeDirWrite("node /tmp/t0411-does-not-exist-xyz.js", { cwd: "/home/example/worktree" })
    ).toBe(false);
  });

  it("leaves an in-worktree script's own content unread -- ordinary in-repo automation (tools/board/scripts/*.js) isn't re-read on every invocation just because it happens to mention .claude/ in a comment or test fixture", () => {
    expect(
      commandTargetsClaudeDirWrite("node tools/board/scripts/validateBacklog.js", {
        cwd: "/home/example/worktree",
        readFile: () => "this file happens to mention .claude/agents/infra.md in a comment"
      })
    ).toBe(false);
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

  it("leaves the planner phase's legitimate tasks/*.md writes alone -- no .claude/ mention, nothing to deny", () => {
    expect(
      commandTargetsClaudeDirWrite(
        `node -e "require('fs').writeFileSync('tasks/T-1234.md', '---\\ntitle: x\\n---\\n')"`
      )
    ).toBe(false);
    expect(commandTargetsClaudeDirWrite("git add tasks/T-1234.md && git commit -m 'feat: T-1234'")).toBe(
      false
    );
  });

  it("denies a compound command where only one &&/;-joined segment targets .claude/", () => {
    expect(
      commandTargetsClaudeDirWrite("npm test && node -e \"require('fs').writeFileSync('.claude/rules/x.md','y')\"")
    ).toBe(true);
  });

  it("documents a known gap: a write through a symlink whose target resolves under .claude/, with no literal .claude mention in the command, is NOT caught by this heuristic", () => {
    // `ln -s .claude/rules sneaky` (denied above, `ln` isn't read-only and mentions .claude/)
    // followed by a LATER, separate command `echo x > sneaky/scratch.md` has no `.claude` text
    // anywhere in *this* command string -- static analysis of the command alone cannot resolve
    // `sneaky` against the real filesystem to see where it points. This is exactly the class of
    // gap claudeDirWriteGuard.js's diff-based backstop exists to close: a write through a symlink
    // still lands at a real path under .claude/ once committed, which the backstop catches
    // regardless of how it got there.
    expect(commandTargetsClaudeDirWrite("echo x > sneaky/scratch.md")).toBe(false);
  });

  it("handles non-string/empty input without throwing", () => {
    expect(commandTargetsClaudeDirWrite("")).toBe(false);
    expect(commandTargetsClaudeDirWrite(undefined)).toBe(false);
    expect(commandTargetsClaudeDirWrite(null)).toBe(false);
  });
});
