const VERDICT_BLOCK_RE = /```verdict\s*\n([\s\S]*?)\n```/g;
const VALID_VERDICTS = new Set(["PASS", "FAIL", "NEEDS_HUMAN_DECISION"]);

function collectText(events) {
  const texts = [];
  for (const event of events) {
    if (event.type === "assistant" && event.message && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        }
      }
    }
    if (event.type === "result" && typeof event.result === "string") {
      texts.push(event.result);
    }
  }
  return texts.join("\n");
}

/**
 * Pulls the reviewer's machine-readable verdict out of a run's parsed NDJSON
 * events. The reviewer is instructed (reviewerPrompt.js) to end its final
 * message with a fenced ```verdict block containing
 * {"verdict": "PASS"|"FAIL"|"NEEDS_HUMAN_DECISION", "notes": "..."};
 * NEEDS_HUMAN_DECISION (T-0341) is for when the card's own acceptance
 * criteria have become a scope or design question the reviewer cannot
 * resolve -- the orchestrator halts the auto-retry loop immediately on it,
 * unlike FAIL. If the last such block is missing, malformed, or names a
 * verdict outside this set, this returns null -- the orchestrator treats
 * that as a runner failure (blocked), not a graded FAIL.
 */
export function extractVerdictFromEvents(events) {
  const combined = collectText(events);

  let match;
  let lastBlock = null;
  VERDICT_BLOCK_RE.lastIndex = 0;
  while ((match = VERDICT_BLOCK_RE.exec(combined)) !== null) {
    lastBlock = match[1];
  }
  if (lastBlock === null) {
    return null;
  }

  let data;
  try {
    data = JSON.parse(lastBlock);
  } catch {
    return null;
  }
  if (!VALID_VERDICTS.has(data.verdict)) {
    return null;
  }
  return { verdict: data.verdict, notes: typeof data.notes === "string" ? data.notes : "" };
}
