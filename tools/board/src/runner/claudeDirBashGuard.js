import fs from "node:fs";
import path from "node:path";

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
 * Two narrow classes of write never mention `.claude/` in the command's own text at all, because
 * the target path lives inside a *referenced file's content* instead of argv: a `git apply`/`git
 * am`/`patch` call (the touched path is a diff header inside the patch file) and an interpreter
 * invocation of a script file (`node`/`python`/`bash`/...) whose own source does the write. Two
 * prior review rounds on this card both flagged exactly these shapes as unrefused. This module now
 * reads the referenced file's content for those two cases specifically -- see
 * `segmentReferencesClaudeDirViaFile` below for the exact scope (patch targets unconditionally;
 * interpreter scripts only when they resolve *outside* the current worktree, so ordinary in-repo
 * automation like `tools/board/scripts/*.js` is never re-read on every invocation).
 *
 * This is still a best-effort first line, not the guarantee. Static analysis of an arbitrary shell
 * command is fundamentally incomplete -- a write routed through a symlink whose target resolves
 * under `.claude/`, with no literal `.claude` mention anywhere this module can see (not command
 * text, not a referenced file's content), still cannot be caught this way; nor can an in-worktree
 * scratch script, deliberately left unread for the reason above. `claudeDirWriteGuard.js`'s
 * diff-based backstop is what actually closes the remaining gap: it inspects the committed result,
 * not the command that produced it, so it catches a write regardless of how indirectly the command
 * that made it was expressed.
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

const DEFAULT_READ_FILE = (resolvedPath) => {
  try {
    return fs.readFileSync(resolvedPath, "utf8");
  } catch {
    return null;
  }
};

/** Resolves a shell-token path argument (`~/x`, a relative path, or an absolute one) against `cwd`. */
function resolvePathArg(token, cwd) {
  if (typeof token !== "string" || token.length === 0) return null;
  let raw = token;
  if (raw === "~") raw = process.env.HOME ?? "";
  else if (raw.startsWith("~/")) raw = path.join(process.env.HOME ?? "", raw.slice(2));
  if (raw.length === 0) return null;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw);
}

/** The target of a single `<` (not `<<` heredoc) stdin redirect in `segment`, if any. */
function findRedirectInputPath(segment) {
  const match = segment.match(/(?:^|\s)<(?!<)\s*(\S+)/);
  return match ? match[1].replace(/^['"]|['"]$/g, "") : null;
}

/**
 * A `git apply`/`git am`/`patch` target's own path never has to mention `.claude/` -- the file it
 * writes to is named inside the patch's own diff headers (`+++ b/.claude/...`). Fails closed: an
 * unresolvable or unreadable target is treated as risky rather than assumed safe, since these verbs
 * exist specifically to write arbitrary file content and have no ordinary role in board-run traffic.
 */
function patchTargetMentionsClaudeDir(token, cwd, readFile) {
  const resolved = resolvePathArg(token, cwd);
  if (!resolved) return true;
  const content = readFile(resolved);
  if (content === null) return true;
  return mentionsClaudeDirPath(content);
}

/** `git apply`/`git am`: candidate patch-file paths are non-flag args plus a `<` redirect target. */
function gitApplyCandidates(tokens, segment) {
  const argPaths = tokens.slice(2).filter((t) => !t.startsWith("-"));
  const redirectPath = findRedirectInputPath(segment);
  return redirectPath ? [...argPaths, redirectPath] : argPaths;
}

/** `patch`: candidate patch-file paths are non-flag args (covers `-i <file>`) plus a `<` redirect target. */
function patchUtilityCandidates(tokens, segment) {
  const argPaths = tokens.slice(1).filter((t) => !t.startsWith("-"));
  const redirectPath = findRedirectInputPath(segment);
  return redirectPath ? [...argPaths, redirectPath] : argPaths;
}

const INTERPRETER_VERBS = new Set([
  "node", "nodejs", "python", "python3", "bash", "sh", "zsh", "ruby", "perl", "ts-node"
]);
const INTERPRETER_INLINE_FLAGS = new Set(["-e", "-c", "--eval"]);

/** The interpreter's script-file argument, if any -- skips flags and an `-e`/`-c` inline payload. */
function findInterpreterScriptToken(tokens) {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-")) continue;
    if (INTERPRETER_INLINE_FLAGS.has(tokens[i - 1])) continue; // it's the -e/-c payload, not a file
    return token;
  }
  return null;
}

/**
 * Whether `segment` references a file -- outside the command's own text -- whose *content* writes
 * under `.claude/`. Covers exactly two shapes, both flagged unrefused by prior review rounds on
 * this card:
 *
 * 1. `git apply`/`git am`/`patch`: the patch file's own diff headers name the target.
 * 2. An interpreter (`node`/`python`/...) running a script file that resolves *outside* the current
 *    worktree -- the "temp script written elsewhere and then executed" shape. An in-worktree
 *    script's content is deliberately left unread: re-reading every `tools/board/scripts/*.js` (or
 *    any other in-repo automation) on every invocation would risk false-positiving on ordinary work
 *    that merely *mentions* a `.claude/` path (a comment, a test fixture, this very file), which
 *    the "ordinary Bash is not broken" requirement rules out. That narrower in-worktree case, like
 *    the symlink-indirection case, is left to the diff-based backstop.
 */
function segmentReferencesClaudeDirViaFile(segment, cwd, readFile) {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return false;
  const bareVerb = tokens[0].split("/").pop();

  if (bareVerb === "git" && (tokens[1] === "apply" || tokens[1] === "am")) {
    const candidates = gitApplyCandidates(tokens, segment);
    if (candidates.length === 0) return true; // e.g. reading a patch off stdin with no visible source
    return candidates.some((c) => patchTargetMentionsClaudeDir(c, cwd, readFile));
  }

  if (bareVerb === "patch") {
    const candidates = patchUtilityCandidates(tokens, segment);
    if (candidates.length === 0) return true;
    return candidates.some((c) => patchTargetMentionsClaudeDir(c, cwd, readFile));
  }

  if (INTERPRETER_VERBS.has(bareVerb)) {
    const scriptToken = findInterpreterScriptToken(tokens);
    if (!scriptToken) return false;
    const resolved = resolvePathArg(scriptToken, cwd);
    if (!resolved) return false;
    const relativeToWorktree = path.relative(cwd, resolved);
    const isOutsideWorktree = relativeToWorktree.startsWith("..") || path.isAbsolute(relativeToWorktree);
    if (!isOutsideWorktree) return false;
    const content = readFile(resolved);
    if (content === null) return false; // can't read it -- nothing to flag, don't fail closed on ordinary tooling
    return mentionsClaudeDirPath(content);
  }

  return false;
}

/**
 * Whether `command` (a raw Bash tool_use command string) appears to write under `.claude/`.
 *
 * `options.cwd` defaults to `process.cwd()` -- correct as-is for the real hook process, which
 * inherits the `claude` CLI's own cwd (the card's worktree). `options.readFile` defaults to a real
 * `fs.readFileSync`; both are overridable for tests so the file-content checks don't require actual
 * files on disk.
 */
export function commandTargetsClaudeDirWrite(command, options = {}) {
  if (typeof command !== "string" || command.length === 0) return false;
  const cwd = options.cwd ?? process.cwd();
  const readFile = options.readFile ?? DEFAULT_READ_FILE;
  const segments = splitTopLevelSegments(command);
  if (mentionsClaudeDirPath(command) && segments.some(segmentIsClaudeDirWrite)) {
    return true;
  }
  return segments.some((segment) => segmentReferencesClaudeDirViaFile(segment, cwd, readFile));
}
