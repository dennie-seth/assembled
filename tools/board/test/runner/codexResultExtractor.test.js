import { describe, it, expect } from "vitest";
import { extractCodexResult } from "../../src/runner/codexResultExtractor.js";

function ndjson(...events) {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("extractCodexResult", () => {
  it("extracts a fenced JSON payload from the last agent_message item", () => {
    const payload = { outcome: "PASS", job: { jobId: "j", ticketId: "T-1", sprintId: "s" } };
    const stdout = ndjson(
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "```json\n" + JSON.stringify(payload) + "\n```" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }
    );
    const result = extractCodexResult(stdout);
    expect(result.kind).toBe("payload");
    expect(result.payload).toEqual(payload);
  });

  it("extracts a bare (unfenced) JSON payload from the agent_message text", () => {
    const payload = { outcome: "BLOCKED" };
    const stdout = ndjson({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: JSON.stringify(payload) } });
    const result = extractCodexResult(stdout);
    expect(result.kind).toBe("payload");
    expect(result.payload).toEqual(payload);
  });

  it("uses the LAST agent_message when several are present", () => {
    const stdout = ndjson(
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: JSON.stringify({ outcome: "FIRST" }) } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: JSON.stringify({ outcome: "SECOND" }) } }
    );
    const result = extractCodexResult(stdout);
    expect(result.payload.outcome).toBe("SECOND");
  });

  it("ignores non-agent_message items (e.g. command_execution) when hunting for the final payload", () => {
    const payload = { outcome: "PASS" };
    const stdout = ndjson(
      { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "head -n1 x", aggregated_output: "x", exit_code: 0 } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: JSON.stringify(payload) } }
    );
    const result = extractCodexResult(stdout);
    expect(result.kind).toBe("payload");
    expect(result.payload).toEqual(payload);
  });

  it("returns a parse-failure when no agent_message item exists at all", () => {
    const stdout = ndjson({ type: "thread.started", thread_id: "t1" }, { type: "turn.started" });
    const result = extractCodexResult(stdout);
    expect(result.kind).toBe("parse-failure");
    expect(result.reason).toBe("no-agent-message");
  });

  it("returns a parse-failure for truncated/invalid JSON in the final agent_message, never a silently empty payload", () => {
    const stdout = ndjson({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: '{"outcome": "PASS", "findings": [' } });
    const result = extractCodexResult(stdout);
    expect(result.kind).toBe("parse-failure");
    expect(result.reason).toBe("invalid-json");
  });

  it("returns a parse-failure for completely empty stdout (e.g. the process was killed before emitting anything)", () => {
    const result = extractCodexResult("");
    expect(result.kind).toBe("parse-failure");
    expect(result.reason).toBe("no-agent-message");
  });

  it("tolerates stray non-JSON lines mixed into the stream without throwing", () => {
    const payload = { outcome: "PASS" };
    const stdout = "Reading additional input from stdin...\n" + ndjson({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: JSON.stringify(payload) } });
    const result = extractCodexResult(stdout);
    expect(result.kind).toBe("payload");
    expect(result.payload).toEqual(payload);
  });
});
