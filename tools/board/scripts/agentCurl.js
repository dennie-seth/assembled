#!/usr/bin/env node
/**
 * Scoped `curl` wrapper -- the HTTP client granted to the `assets` and
 * `audio` agents in place of a blanket `Bash(curl:*)`.
 *
 *   node tools/board/scripts/agentCurl.js <METHOD> <URL> [curl args...]
 *
 * The method and URL are fixed by the first two arguments; everything after
 * them is passed to curl verbatim, minus flags that could override either
 * (`-X`, `--url`, `--next`, `-K`, ...). See `src/lib/agentCurlPolicy.js` for
 * the policy and the reasoning behind it.
 *
 * Exit codes: curl's own on success, 2 on a policy denial, 64 on bad usage.
 */
import { spawn } from "node:child_process";
import { checkAgentCurlRequest } from "../src/lib/agentCurlPolicy.js";

const USAGE = "usage: node tools/board/scripts/agentCurl.js <METHOD> <URL> [curl args...]";

const [method, url, ...rest] = process.argv.slice(2);

if (!method || !url) {
  console.error(`agentCurl: ${USAGE}`);
  process.exit(64);
}

const verdict = checkAgentCurlRequest({
  method,
  url,
  args: rest,
  boardPort: process.env.BOARD_PORT
});

if (!verdict.allowed) {
  console.error(`agentCurl: denied -- ${verdict.reason}`);
  process.exit(2);
}

// Every request this wrapper forwards is, by definition, an agent's. Stamping that identity is
// what lets the board's human direction-approval gate (src/lib/approvalGate.js) refuse to read
// an agent action as a human approval on the routes it *does* allow through. Third layer of
// defence, not the first: the policy above already refuses every mutating board route bar
// attachment upload, and the orchestrator's own write path refuses to complete an unapproved
// approval-gated card regardless of what any request claims.
const child = spawn(
  "curl",
  ["--request", method.toUpperCase(), "--header", "X-Board-Actor: agent", ...rest, "--url", url],
  { stdio: "inherit" }
);

child.on("error", (err) => {
  console.error(`agentCurl: failed to run curl: ${err.message}`);
  process.exit(127);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(128);
  }
  process.exit(code ?? 1);
});
