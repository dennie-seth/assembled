/**
 * T-0460: turns a `codex exec --json` run's raw NDJSON stdout into the `runResult` shape
 * `codexVerdictPublisher.js` expects -- `{ kind: "payload", payload }` on success or
 * `{ kind: "parse-failure", reason, detail }` when the final message is missing, truncated, or
 * not valid JSON. Deliberately never falls back to an empty/default payload: a result that can't
 * be parsed must surface as a failure the publisher turns into BLOCKED, not as "no findings".
 */

const FENCED_JSON_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/;

export function extractCodexResult(stdout) {
  const lines = String(stdout).split("\n").filter((line) => line.trim().length > 0);

  let lastAgentMessageText = null;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a stray non-JSON line (e.g. "Reading additional input from stdin...") -- skip it
    }
    if (event && event.type === "item.completed" && event.item && event.item.type === "agent_message" && typeof event.item.text === "string") {
      lastAgentMessageText = event.item.text;
    }
  }

  if (lastAgentMessageText === null) {
    return { kind: "parse-failure", reason: "no-agent-message", detail: "no agent_message item found in the NDJSON stream" };
  }

  const fencedMatch = FENCED_JSON_RE.exec(lastAgentMessageText);
  const jsonText = fencedMatch ? fencedMatch[1] : lastAgentMessageText;

  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch (err) {
    return { kind: "parse-failure", reason: "invalid-json", detail: err.message };
  }

  return { kind: "payload", payload };
}
