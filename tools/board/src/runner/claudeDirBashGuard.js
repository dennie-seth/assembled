/**
 * T-0411: the CLI's own sensitive-file protection denies every Edit/Write under `.claude/` in an
 * unattended run (T-0374) -- but that check is scoped to the Edit/Write *tools specifically*, not
 * to "anything that writes a file". A `Bash` tool call carries an opaque command string, and
 * nothing on the CLI side inspects what that command will touch, so `node -e
 * "require('fs').writeFileSync('.claude/rules/x.md', ...)"` sails straight through -- this is
 * exactly how T-0408 attempt 3 rewrote `.claude/agents/planner.md` and `.claude/rules/planner.md`
 * from inside a run.
 *
 * `commandTargetsClaudeDirWrite` is the heuristic `claudeDirBashHook.js` (wired into the `claude`
 * CLI as a `PreToolUse` hook via `claudeCliRunner.js`'s `--settings`) uses to deny a Bash call
 * before it runs. It is deliberately fail-closed: default to "denied" for anything that mentions a
 * `.claude/` path and isn't recognizably read-only, rather than trying to enumerate every possible
 * write shape.
 *
 * This is a best-effort first line, not the guarantee. Static analysis of an arbitrary shell
 * command is fundamentally incomplete -- `node /tmp/script.js`, where `/tmp/script.js` was written
 * by an earlier, unrelated Bash call and its own source never appears in this command's argv at
 * all, cannot be distinguished from any other `node` invocation by looking at the command text
 * alone. `claudeDirWriteGuard.js`'s diff-based backstop is what actually closes that gap: it
 * inspects the committed result, not the command that produced it, so it catches a write
 * regardless of how indirectly the command that made it was expressed.
 */

/**
 * Matches a `.claude` path segment, requiring a real word/quote/path boundary on both sides so a
 * path that merely *looks* like the directory -- `my.claude/`, `claude/`, `.claude-notes/` -- is
 * left alone (docs/notes-on-.claude.md's trailing text also fails the boundary check). Segments
 * before the literal `.claude` may be plain path components, `.`/`..` traversal, or `~` (home
 * dir) in any combination/order, so `tools/../.claude/x`, `../.claude/x`, and `~/.claude/x` all
 * match.
 */
const CLAUDE_DIR_MENTION_RE = /(?:^|[\s"'(=:,/])(?:(?:\.\.?|~|[\w.-]+)\/)*\.claude(?=$|[/\s"')])/;

function mentionsClaudeDirPath(text) {
  return typeof text === "string" && CLAUDE_DIR_MENTION_RE.test(text);
}

/** Whether any `>`/`>>` redirection in `segment` targets a path under `.claude/`. */
function hasClaudeDirRedirect(segment) {
  let idx = -1;
  while ((idx = segment.indexOf(">", idx + 1)) !== -1) {
    // A generous slice past the redirect operator, not just the next token -- the target may be
    // quoted or have leading whitespace, and over-reading a little costs nothing here.
    if (mentionsClaudeDirPath(segment.slice(idx + 1, idx + 300))) {
      return true;
    }
  }
  return false;
}

/**
 * Quote-aware whitespace tokenizer -- good enough to pull a command's verb and arguments apart
 * for this heuristic. Not a full shell grammar (no variable expansion, no nested command
 * substitution); the diff-based backstop is what covers what this can't parse.
 */
function tokenize(segment) {
  const tokens = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && segment[i - 1] !== "\\") inDouble = false;
      else current += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Splits a compound command into its top-level `;`/`&&`/`||`/`|`/newline-joined segments, quote-aware. */
function splitTopLevelSegments(command) {
  const segments = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"' && command[i - 1] !== "\\") inDouble = false;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
      segments.push(current);
      current = "";
      i += 2;
      continue;
    }
    if (ch === "|") {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** Command verbs that only ever read the filesystem -- never a write signal by themselves. */
const READ_ONLY_VERBS = new Set([
  "cat", "grep", "egrep", "fgrep", "rg", "head", "tail", "less", "more", "wc",
  "ls", "file", "stat", "realpath", "dirname", "basename", "echo", "printf",
  "pwd", "which", "type", "find", "diff", "test"
]);

/** `find`'s own write-capable flags -- `-delete`/`-exec` etc. can mutate despite the bare verb being read-only. */
const FIND_WRITE_FLAG_RE = /(^|\s)-(delete|exec|execdir|fprint|fprintf|ok|okdir)(\s|$)/;

/** `git` subcommands that never touch the working tree, regardless of what path they're pointed at. */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "log", "diff", "show", "blame", "status", "ls-files", "ls-tree", "cat-file",
  "rev-parse", "branch", "describe", "shortlog", "reflog"
]);

function segmentIsClaudeDirWrite(segment) {
  if (!mentionsClaudeDirPath(segment)) return false;

  // A redirect always wins, regardless of the leading verb: `cat`/`echo`/`printf` are read-only
  // on their own, but `cat <<EOF > .claude/x` or `echo y > .claude/x` write.
  if (hasClaudeDirRedirect(segment)) return true;

  const tokens = tokenize(segment);
  const bareVerb = (tokens[0] ?? "").split("/").pop();

  if (bareVerb === "git") {
    const sub = tokens[1] ?? "";
    return !GIT_READ_ONLY_SUBCOMMANDS.has(sub);
  }

  if (READ_ONLY_VERBS.has(bareVerb)) {
    if (bareVerb === "find" && FIND_WRITE_FLAG_RE.test(segment)) {
      return true;
    }
    return false;
  }

  // Fail closed: anything else that mentions a .claude/ path -- an interpreter's inline `-e`/`-c`
  // eval, an unrecognized write utility (tee/cp/mv/sed -i/rsync/patch/...), a script invocation
  // with the path as an argument -- is denied by default rather than requiring every write shape
  // to be enumerated.
  return true;
}

/** Whether `command` (a raw Bash tool_use command string) appears to write under `.claude/`. */
export function commandTargetsClaudeDirWrite(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  if (!mentionsClaudeDirPath(command)) return false;
  return splitTopLevelSegments(command).some(segmentIsClaudeDirWrite);
}
