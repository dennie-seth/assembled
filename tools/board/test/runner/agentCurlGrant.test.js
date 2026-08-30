import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveAllowedTools, isToolAllowed } from "../../src/runner/toolAllowlist.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REAL_AGENTS_DIR = path.join(REPO_ROOT, ".claude", "agents");
const WRAPPER = path.join(REPO_ROOT, "tools", "board", "scripts", "agentCurl.js");

const CURL_GRANTED_AGENTS = ["assets", "audio"];

/**
 * T-0221: `assets` and `audio` carried a blanket `Bash(curl:*)`, which also
 * reached the board's own mutating task API on loopback -- an implementer
 * whose `gh pr create` was denied used it to PATCH its own card to `review`.
 * The `--allowedTools` grammar the runner emits is a command-prefix match
 * with one trailing `*` (`toolAllowlist.isToolAllowed`), so a `Bash(curl ...)`
 * pattern cannot say "any flags, but only to host X". The grant therefore
 * names a wrapper, and the host policy lives inside it.
 */
describe("agent grants: no unscoped curl anywhere", () => {
  it.each(fs.readdirSync(REAL_AGENTS_DIR).filter((f) => f.endsWith(".md")))(
    "%s has no blanket curl grant",
    (file) => {
      const agent = path.basename(file, ".md");
      const resolved = resolveAllowedTools(agent, { agentsDir: REAL_AGENTS_DIR });
      expect(resolved).not.toContain("Bash(curl:*)");
      expect(resolved.some((t) => /^Bash\(curl[\s:)]/.test(t))).toBe(false);
      expect(isToolAllowed("Bash(curl:-s -X PATCH http://127.0.0.1:4173/api/tasks/T-0153)", resolved)).toBe(
        false
      );
    }
  );

  it.each(CURL_GRANTED_AGENTS)("%s is granted the scoped wrapper instead", (agent) => {
    const resolved = resolveAllowedTools(agent, { agentsDir: REAL_AGENTS_DIR });
    expect(resolved).toContain("Bash(node tools/board/scripts/agentCurl.js:*)");
    // The prefix grant must actually match the real invocation shapes.
    expect(
      isToolAllowed(
        "Bash(node tools/board/scripts/agentCurl.js:GET http://172.18.192.1:8188/system_stats -s)",
        resolved
      )
    ).toBe(true);
    expect(
      isToolAllowed(
        "Bash(node tools/board/scripts/agentCurl.js:POST http://127.0.0.1:4173/api/tasks/T-0214/attachments -F file=@x.png)",
        resolved
      )
    ).toBe(true);
  });

  it("the wrapper the grant names actually exists at that path", () => {
    expect(fs.existsSync(WRAPPER)).toBe(true);
  });
});

/**
 * End-to-end through the real script: policy denials must stop before curl
 * ever runs, and allowed calls must reach curl. `--fail-with-body`-free dry
 * checks only -- no network is required for the denial cases, and the allowed
 * case is pointed at a closed port so curl exits non-zero from *connect*,
 * proving it was invoked rather than blocked.
 */
describe("agentCurl.js end to end", () => {
  const run = (args) =>
    spawnSync(process.execPath, [WRAPPER, ...args], { encoding: "utf8", cwd: REPO_ROOT });

  it("denies a board-API PATCH with exit 2 and never invokes curl", () => {
    const result = run([
      "PATCH",
      "http://127.0.0.1:4173/api/tasks/T-0153",
      "-H",
      "Content-Type: application/json",
      "-d",
      '{"status":"review"}'
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/denied/);
    expect(result.stderr).toMatch(/board API/);
  });

  it("denies the same PATCH through the vite proxy port", () => {
    expect(run(["PATCH", "http://127.0.0.1:5173/api/tasks/T-0153"]).status).toBe(2);
  });

  it("denies POST to the board's non-attachment mutating routes", () => {
    expect(run(["POST", "http://127.0.0.1:4173/api/tasks/T-0153/run"]).status).toBe(2);
    expect(run(["POST", "http://127.0.0.1:4173/api/tasks"]).status).toBe(2);
  });

  it("denies a smuggled second URL and a -X override", () => {
    expect(
      run(["GET", "http://172.18.192.1:8188/system_stats", "http://127.0.0.1:4173/api/tasks/T-1"])
        .status
    ).toBe(2);
    expect(run(["GET", "http://172.18.192.1:8188/system_stats", "-X", "PATCH"]).status).toBe(2);
  });

  it("lets an allowed target through to curl (connect failure, not a policy denial)", () => {
    // Port 9 (discard) is closed on loopback -- curl exits 7 "couldn't connect",
    // which can only happen if the policy passed and curl actually ran.
    const result = run(["GET", "http://127.0.0.1:9/system_stats", "-s", "--connect-timeout", "2"]);
    expect(result.status).not.toBe(2);
    expect(result.stderr).not.toMatch(/denied/);
  });

  it("reports bad usage distinctly from a policy denial", () => {
    expect(run([]).status).toBe(64);
    expect(run(["GET"]).status).toBe(64);
  });

  // AP-5 (docs/board-invariants.md §9): everything this wrapper forwards is an agent's, and the
  // board's approval gate needs to be able to tell. Asserted against a real listening server
  // rather than the argv we constructed, so the header is proven to survive the spawn and reach
  // the wire. Deliberately NOT on a board port -- this is the pass-through case (ComfyUI, the
  // audio services), which is exactly where an agent request can still reach a server at all.
  it("stamps X-Board-Actor: agent on every request it forwards", async () => {
    const received = [];
    const echo = http.createServer((req, res) => {
      received.push(req.headers);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const { port } = echo.address();

    try {
      // spawn, not spawnSync: the echo server shares this process's event loop, so a
      // synchronous child would block the very response it is waiting for.
      const exitCode = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [WRAPPER, "GET", `http://127.0.0.1:${port}/system_stats`, "-s"], {
          cwd: REPO_ROOT,
          stdio: "ignore"
        });
        child.on("error", reject);
        child.on("exit", resolve);
      });

      expect(exitCode).toBe(0);
      expect(received).toHaveLength(1);
      expect(received[0]["x-board-actor"]).toBe("agent");
    } finally {
      await new Promise((resolve) => echo.close(resolve));
    }
  });
});

/**
 * The wrapper invocations the agent instructions prescribe have to be commands
 * the runner can actually execute. Two ways they silently could not be, both
 * seen live on T-0218 (2026-08-23):
 *
 *  - `${BOARD_PORT:-4173}` in the documented attachment upload. The Claude Code
 *    Bash tool refuses any command containing `${}` outright -- the run log shows
 *    `Command contains ${} parameter substitution` -- so an agent that copies the
 *    documented line verbatim can never upload its deliverable.
 *  - An absolute path to the wrapper. The grant is a *prefix* match on the
 *    relative `node tools/board/scripts/agentCurl.js`, so
 *    `node /home/.../worktrees/T-0218/tools/board/scripts/agentCurl.js ...` is
 *    denied ("This command requires approval"). The docs must therefore only ever
 *    show the repo-relative form.
 */
describe("documented agentCurl invocations are runnable as written", () => {
  const DOC_FILES = [
    path.join(REPO_ROOT, ".claude", "agents", "assets.md"),
    path.join(REPO_ROOT, ".claude", "agents", "audio.md"),
    path.join(REPO_ROOT, ".claude", "rules", "assets.md"),
    path.join(REPO_ROOT, ".claude", "rules", "conduct.md")
  ];

  /**
   * Every line of `file` that is an actual wrapper invocation, with markdown backticks
   * stripped: it starts the command, rather than merely mentioning the script in prose or
   * carrying the `Bash(node ...:*)` grant string itself.
   */
  const wrapperLines = (file) =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.replace(/`/g, "").trim())
      .filter((line) => line.startsWith("node ") && line.includes("agentCurl.js"));

  it.each(DOC_FILES)("%s documents at least one wrapper invocation", (file) => {
    expect(wrapperLines(file).length).toBeGreaterThan(0);
  });

  it.each(DOC_FILES)("%s never shows ${} substitution the Bash tool refuses", (file) => {
    for (const line of wrapperLines(file)) {
      expect(line).not.toMatch(/\$\{/);
    }
    // The URL continuation lines of a multi-line example carry the port, not the
    // `agentCurl.js` token, so check the whole attachment-upload snippet too.
    const raw = fs.readFileSync(file, "utf8");
    const uploads = raw.match(/^.*api\/tasks\/<id>\/attachments.*$/gm) ?? [];
    for (const line of uploads) {
      expect(line).not.toMatch(/\$\{/);
    }
  });

  it.each(DOC_FILES)("%s invokes the wrapper by the repo-relative path the grant matches", (file) => {
    const resolved = resolveAllowedTools("assets", { agentsDir: REAL_AGENTS_DIR });
    for (const line of wrapperLines(file)) {
      const invocation = line.slice(line.indexOf("node "));
      expect(invocation.startsWith("node tools/board/scripts/agentCurl.js")).toBe(true);
      const [, ...args] = invocation.split(/\s+/);
      expect(isToolAllowed(`Bash(node ${args[0]}:${args.slice(1).join(" ")})`, resolved)).toBe(true);
    }
  });
});
