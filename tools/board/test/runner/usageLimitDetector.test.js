import { describe, it, expect } from "vitest";
import { eventsContainUsageLimitSignature } from "../../src/runner/usageLimitDetector.js";

function assistantText(text) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

describe("eventsContainUsageLimitSignature", () => {
  it("detects a usage-limit phrase in an assistant text block", () => {
    const events = [assistantText("Claude AI usage limit reached. Your limit will reset at 3pm.")];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });

  it("detects a rate-limit phrase in a result event's result field", () => {
    const events = [{ type: "result", is_error: true, result: "Error: rate limited, please retry later" }];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });

  it("detects a raw 429 marker anywhere in the event payload", () => {
    const events = [{ type: "system", subtype: "error", message: "upstream request failed with status 429" }];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });

  it("detects a quota-exceeded phrase", () => {
    const events = [assistantText("You have exceeded your weekly quota for this plan.")];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });

  it("is case-insensitive", () => {
    const events = [assistantText("USAGE LIMIT REACHED")];
    expect(eventsContainUsageLimitSignature(events)).toBe(true);
  });

  it("returns false for a genuine code/test failure with no limit signature", () => {
    const events = [assistantText("TypeError: cannot read properties of undefined (reading 'foo')")];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });

  it("returns false for an empty events array", () => {
    expect(eventsContainUsageLimitSignature([])).toBe(false);
  });

  it("returns false for a non-array input", () => {
    expect(eventsContainUsageLimitSignature(null)).toBe(false);
    expect(eventsContainUsageLimitSignature(undefined)).toBe(false);
  });

  it("does not false-positive on unrelated text merely containing the word 'limit'", () => {
    const events = [assistantText("I set a character limit of 80 columns for this file per the style guide.")];
    expect(eventsContainUsageLimitSignature(events)).toBe(false);
  });
});
