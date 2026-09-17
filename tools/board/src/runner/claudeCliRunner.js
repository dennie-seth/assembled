import { spawn as nodeSpawn } from "node:child_process";
import { AgentRunner } from "./agentRunner.js";
import { DEFAULT_KILL_ESCALATION_MS } from "./runState.js";

// BOARD_TASK_STORE/BOARD_DB_PATH MUST be included: without them, a child `claude` CLI process
// (and the reviewer/implementer scripts it runs via its own Bash tool -- checkDeliverable.js,
// checkPlannerDiffGuard.js, validateBacklog.js) always falls back to `fs` mode, resolving
// attachments/tasks from `tasks/*.md` instead of the live SQLite store the parent board process
// is actually running in `BOARD_TASK_STORE=db` mode. That gap made #225's DB-mode attachment
// gate false-FAIL every real db-mode artifact card (T-0213/T-0214) with "no attachments
// recorded" even though the files were attached in the DB -- see docs/design/cards-to-database.md.
export const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TZ",
  "BOARD_TASK_STORE",
  "BOARD_DB_PATH"
];

/**
 * Validates a `--model` value before it reaches argv. Accepts Claude Code's
 * short aliases (sonnet/opus/haiku/fable) and full model strings (e.g.
 * "claude-sonnet-5", "claude-opus-4-1-20250805", or a Bedrock-style
 * "us.anthropic.claude-3-5-sonnet-...:0" id) -- deliberately not an
 * exhaustive allowlist, since new model names ship independently of this
 * repo. Rejects non-strings (malformed frontmatter, e.g. a YAML mapping),
 * blank/whitespace-only values, embedded whitespace, and anything starting
 * with "-" (which argv would otherwise parse as a CLI flag). Returns
 * `undefined` unchanged so "no model configured" stays silent.
 */
function validateModel(model) {
  if (model === undefined || model === null) {
    return undefined;
  }
  if (typeof model !== "string") {
    throw new Error(`ClaudeCliRunner: model must be a string, got ${JSON.stringify(model)}`);
  }
  const trimmed = model.trim();
  if (trimmed.length === 0) {
    throw new Error("ClaudeCliRunner: model must not be blank");
  }
  if (/\s/.test(trimmed)) {
    throw new Error(`ClaudeCliRunner: model "${trimmed}" must not contain whitespace`);
  }
  if (trimmed.startsWith("-")) {
    throw new Error(`ClaudeCliRunner: model "${trimmed}" looks like a CLI flag, not a model name`);
  }
  return trimmed;
}

/**
 * Spawns the headless Claude CLI (`claude -p --output-format stream-json`)
 * per card run. Argv construction and env isolation are pure (buildInvocation);
 * start()/kill() are the only methods that touch the injected spawnFn.
 */
export class ClaudeCliRunner extends AgentRunner {
  constructor({
    spawnFn = nodeSpawn,
    command = "claude",
    envAllowlist = DEFAULT_ENV_ALLOWLIST,
    extraEnv = {},
    model,
    hostEnv = process.env
  } = {}) {
    super();
    this.spawnFn = spawnFn;
    this.command = command;
    this.envAllowlist = envAllowlist;
    this.extraEnv = extraEnv;
    this.model = model;
    this.hostEnv = hostEnv;
  }

  buildEnv() {
    const env = {};
    for (const key of this.envAllowlist) {
      if (this.hostEnv[key] !== undefined) {
        env[key] = this.hostEnv[key];
      }
    }
    return { ...env, ...this.extraEnv };
  }

  buildInvocation({ task, prompt, allowedTools, worktreeDir, model }) {
    if (!task || typeof task.id !== "string" || task.id.length === 0) {
      throw new Error("ClaudeCliRunner requires a task with an id");
    }
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new Error("ClaudeCliRunner requires a non-empty prompt");
    }
    if (!Array.isArray(allowedTools)) {
      throw new Error("ClaudeCliRunner requires allowedTools to be an array");
    }
    if (typeof worktreeDir !== "string" || worktreeDir.length === 0) {
      throw new Error("ClaudeCliRunner requires a worktreeDir to isolate the run");
    }

    // --allowedTools also grows with an agent's grants and stays in argv (T-0291 asked that
    // this be accounted for, not necessarily moved): unlike the body, its size is bounded by
    // the grant list a human writes into an agent's `.claude/agents/*.md`, which in practice
    // stays well under a kilobyte -- nothing observed anywhere near MAX_ARG_STRLEN. The body
    // is what's unbounded (it's a whole card, including run history and amendments), which is
    // why it's the one moved off argv entirely below.
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      allowedTools.join(" ")
    ];
    const resolvedModel = validateModel(model ?? this.model);
    if (resolvedModel) {
      args.push("--model", resolvedModel);
    }
    // The prompt is deliberately never an argv element (T-0291): a card body embeds the
    // whole task, and Linux caps a single argv string at MAX_ARG_STRLEN (~128 KiB) --
    // T-0243's ~54 KB body, once wrapped in the agent/rules preamble, crossed it and
    // crashed the run with `spawn E2BIG` *after* the reviewer had already PASSed. `claude -p`
    // with no positional prompt reads it from stdin instead (its own streamed-input path,
    // `--input-format text` by default) -- see start(), which writes it there. That removes
    // the ceiling entirely rather than raising it, unlike routing it through an env var
    // (env has its own, larger but still finite limit).
    return {
      command: this.command,
      args,
      cwd: worktreeDir,
      env: this.buildEnv(),
      prompt
    };
  }

  async start({ task, prompt, allowedTools, worktreeDir, model }) {
    const invocation = this.buildInvocation({ task, prompt, allowedTools, worktreeDir, model });
    let child;
    try {
      child = this.spawnFn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        // Detached so kill() can target the whole process group (-pid), not just this
        // one process -- a headless `claude -p` run may spawn its own Bash-tool
        // children, and a plain child.kill() would leave those orphaned on cancel.
        detached: true,
        // stdin now carries the prompt itself (see buildInvocation's docstring) -- 'pipe'
        // so start() has somewhere to write it, always followed by an explicit end() below
        // so the CLI's own stdin read never blocks waiting for more than was sent.
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (err) {
      // A handful of spawn failures -- E2BIG chief among them (confirmed: on this platform
      // Node's child_process.spawn throws it synchronously, not as an async 'error' event) --
      // surface directly out of the spawnFn() call instead of via the child's 'error' event
      // the try below already handles. Left uncaught, this unwinds straight out of
      // runOrchestrator's _runPhase -> _syncBranchWithDevelop -> _handlePass, discarding an
      // already-successful PASS and PR that had nothing to do with this failure (T-0243).
      // Returning the same {runId, child: null, invocation, spawnError} shape the async path
      // produces means every caller already knows how to handle this without a new code path.
      return { runId: task.id, child: null, invocation, spawnError: err };
    }
    const run = { runId: task.id, child, invocation, spawnError: null };
    // Attached synchronously, in the same tick as spawnFn() above -- Node delivers a spawn
    // failure (e.g. ENOENT when `command` isn't resolvable on the child's PATH) as an async
    // 'error' event, and an EventEmitter with zero listeners for 'error' at that moment throws
    // it as an uncaught exception, crashing the whole board process over one card's run. Callers
    // (runOrchestrator._runPhase) do async I/O -- writeRunStateFn -- between start() returning
    // and attaching their own 'error' listener, which is a real window for a fast ENOENT to beat
    // them to it. Capturing on `run` here means a caller can still observe the failure via
    // `run.spawnError` even if its own listener attaches too late to catch the event itself.
    child.on("error", (err) => {
      run.spawnError = err;
    });
    if (child.stdin) {
      // Same reasoning as the child's own 'error' listener above: an unlistened 'error' on
      // this stream (e.g. EPIPE if the child dies before it finishes reading) would otherwise
      // throw uncaught. Nothing further to do with it -- the child's own exit/error handling
      // already covers what happened to the process as a whole.
      child.stdin.on("error", () => {});
      child.stdin.write(invocation.prompt);
      child.stdin.end();
    }
    return run;
  }

  observe(run) {
    return run.child;
  }

  /**
   * Sends SIGTERM to the child's whole process group (so a grandchild it spawned via its own
   * Bash tool -- e.g. a hung `godot --headless` test -- dies too, not just the `claude` process
   * itself), then escalates to SIGKILL after `escalationMs` if the child is still alive by then.
   * The escalation matters: a subprocess that traps/ignores SIGTERM (or is stuck in an
   * uninterruptible read) would otherwise wedge forever even after a "kill". Cancelled
   * automatically if the child's own `exit` event fires first.
   */
  kill(run, { escalationMs = DEFAULT_KILL_ESCALATION_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    const child = run && run.child ? run.child : run;
    if (!child || typeof child.kill !== "function") {
      return;
    }

    const pid = typeof child.pid === "number" ? child.pid : null;
    const sendSignal = (signal) => {
      if (pid !== null) {
        try {
          process.kill(-pid, signal);
          return;
        } catch {
          // Not a process group leader (or already dead) -- fall back below.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // Already dead -- nothing left to signal.
      }
    };

    sendSignal("SIGTERM");

    const escalationTimer = setTimeoutFn(() => sendSignal("SIGKILL"), escalationMs);
    if (typeof escalationTimer.unref === "function") {
      escalationTimer.unref();
    }
    if (typeof child.once === "function") {
      child.once("exit", () => clearTimeoutFn(escalationTimer));
    }
  }
}
