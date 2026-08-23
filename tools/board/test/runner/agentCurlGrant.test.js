import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
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
});
