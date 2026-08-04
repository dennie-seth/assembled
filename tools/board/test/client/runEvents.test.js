import { describe, it, expect } from "vitest";
import { formatRunEvent } from "../../src/client/runEvents.js";

describe("formatRunEvent", () => {
  it("formats an assistant text event, joining multiple text blocks into one line", () => {
    const event = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Looking at the task." }, { type: "text", text: "Writing tests." }] }
    };
    expect(formatRunEvent(event, "implementer")).toEqual([
      "[implementer] Looking at the task. Writing tests."
    ]);
  });

  it("renders a tool_use block as a concise one-liner alongside assistant text", () => {
    const event = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Running tests." },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test\n--silent" } }
        ]
      }
    };
    expect(formatRunEvent(event, "reviewer")).toEqual([
      "[reviewer] Running tests.",
      "[reviewer] → Bash: npm test"
    ]);
  });

  it("renders Edit/Read/Write tool_use as a tool name plus path", () => {
    const editEvent = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "src/foo.js" } }] }
    };
    expect(formatRunEvent(editEvent, "implementer")).toEqual(["[implementer] → Edit src/foo.js"]);

    const readEvent = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t3", name: "Read", input: { file_path: "src/bar.js" } }] }
    };
    expect(formatRunEvent(readEvent, "implementer")).toEqual(["[implementer] → Read src/bar.js"]);
  });

  it("truncates long tool_use inputs", () => {
    const longCommand = "echo " + "x".repeat(400);
    const event = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t4", name: "Bash", input: { command: longCommand } }] }
    };
    const [line] = formatRunEvent(event, "implementer");
    expect(line.length).toBeLessThan(longCommand.length);
    expect(line).toContain("…");
  });

  it("skips an assistant event with no text and no tool_use blocks (e.g. thinking-only)", () => {
    const event = { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } };
    expect(formatRunEvent(event, "implementer")).toEqual([]);
  });

  it("skips an assistant event with empty content", () => {
    expect(formatRunEvent({ type: "assistant", message: { content: [] } }, "implementer")).toEqual([]);
  });

  it("renders a tool_result (user-role message) as a compact success summary, correlated to the tool name", () => {
    const context = { toolNamesById: new Map() };
    const toolUseEvent = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "npm test" } }] }
    };
    formatRunEvent(toolUseEvent, "implementer", context);

    const resultEvent = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_9", content: "PASS\nPASS\nPASS", is_error: false }
        ]
      }
    };
    expect(formatRunEvent(resultEvent, "implementer", context)).toEqual([
      "[implementer] ✓ Bash result (3 lines)"
    ]);
  });

  it("renders a short single-line tool_result inline instead of a line count", () => {
    const context = { toolNamesById: new Map([["toolu_2", "Read"]]) };
    const resultEvent = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "ok", is_error: false }] }
    };
    expect(formatRunEvent(resultEvent, "implementer", context)).toEqual(["[implementer] ✓ Read: ok"]);
  });

  it("renders a failed tool_result with an error marker", () => {
    const context = { toolNamesById: new Map([["toolu_3", "Bash"]]) };
    const resultEvent = {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_3", content: "command not found", is_error: true }]
      }
    };
    expect(formatRunEvent(resultEvent, "implementer", context)).toEqual([
      "[implementer] ✗ Bash error: command not found"
    ]);
  });

  it("falls back to a generic tool label when the originating tool_use wasn't observed", () => {
    const resultEvent = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "unknown", content: "done", is_error: false }] }
    };
    expect(formatRunEvent(resultEvent, "implementer")).toEqual(["[implementer] ✓ tool: done"]);
  });

  it("skips a user event with no tool_result content", () => {
    const event = { type: "user", message: { content: [{ type: "text", text: "hi" }] } };
    expect(formatRunEvent(event, "implementer")).toEqual([]);
  });

  it("formats a result event", () => {
    expect(formatRunEvent({ type: "result", result: "Done." }, "reviewer")).toEqual(["[reviewer] result: Done."]);
  });

  it("formats an error event", () => {
    expect(formatRunEvent({ type: "error", error: "malformed JSON" }, "implementer")).toEqual([
      "[implementer] error: malformed JSON"
    ]);
  });

  it("skips system/init events as noise", () => {
    expect(formatRunEvent({ type: "system", subtype: "init" }, "implementer")).toEqual([]);
  });

  it("skips an unrecognized event type", () => {
    expect(formatRunEvent({ type: "mystery" }, "implementer")).toEqual([]);
  });

  it("handles a missing/malformed event without throwing", () => {
    expect(formatRunEvent(null, "implementer")).toEqual([]);
    expect(formatRunEvent({}, "implementer")).toEqual([]);
  });

  it("omits the phase prefix when no phase is given", () => {
    expect(formatRunEvent({ type: "result", result: "Done." })).toEqual(["result: Done."]);
  });
});
