import { describe, it, expect } from "vitest";
import { formatRunEvent } from "../../src/client/runEvents.js";

describe("formatRunEvent", () => {
  it("formats a system event with its subtype", () => {
    expect(formatRunEvent({ type: "system", subtype: "init" }, "implementer")).toBe(
      "[implementer] system: init"
    );
  });

  it("formats an assistant text event, joining multiple text blocks", () => {
    const event = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Looking at the task." }, { type: "text", text: "Writing tests." }] }
    };
    expect(formatRunEvent(event, "implementer")).toBe("[implementer] Looking at the task. Writing tests.");
  });

  it("ignores non-text content blocks like tool_use", () => {
    const event = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash" }, { type: "text", text: "Running tests." }] }
    };
    expect(formatRunEvent(event, "reviewer")).toBe("[reviewer] Running tests.");
  });

  it("falls back to a generic label for an assistant event with no text blocks", () => {
    const event = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } };
    expect(formatRunEvent(event, "implementer")).toBe("[implementer] assistant message");
  });

  it("formats a result event", () => {
    expect(formatRunEvent({ type: "result", result: "Done." }, "reviewer")).toBe("[reviewer] result: Done.");
  });

  it("formats an error event", () => {
    expect(formatRunEvent({ type: "error", error: "malformed JSON" }, "implementer")).toBe(
      "[implementer] error: malformed JSON"
    );
  });

  it("falls back to the raw type for an unrecognized event", () => {
    expect(formatRunEvent({ type: "mystery" }, "implementer")).toBe("[implementer] mystery");
  });

  it("handles a missing/malformed event without throwing", () => {
    expect(formatRunEvent(null, "implementer")).toBe("[implementer] (unrecognized event)");
    expect(formatRunEvent({}, "implementer")).toBe("[implementer] (unrecognized event)");
  });

  it("omits the phase prefix when no phase is given", () => {
    expect(formatRunEvent({ type: "system", subtype: "init" })).toBe("system: init");
  });
});
