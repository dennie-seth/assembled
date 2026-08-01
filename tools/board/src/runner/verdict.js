const VERDICT_BLOCK_RE = /```verdict\s*\n([\s\S]*?)\n```/g;

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
 * Pulls the reviewer's machine-readable PASS/FAIL verdict out of a run's
 * parsed NDJSON events. The reviewer is instructed (reviewerPrompt.js) to
 * end its final message with a fenced ```verdict block containing
 * {"verdict": "PASS"|"FAIL", "notes": "..."}; if the last such block is
 * missing or malformed, this returns null -- the orchestrator treats that
 * as a runner failure (blocked), not a graded FAIL.
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
  if (data.verdict !== "PASS" && data.verdict !== "FAIL") {
    return null;
  }
  return { verdict: data.verdict, notes: typeof data.notes === "string" ? data.notes : "" };
}
