import { describe, it, expect } from "vitest";
import { extractVerdictFromEvents } from "../../src/runner/verdict.js";

function assistantText(text) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

describe("extractVerdictFromEvents", () => {
  it("extracts a PASS verdict from the assistant's final text block", () => {
    const events = [
      assistantText("Ran verify, everything is green."),
      assistantText('```verdict\n{"verdict": "PASS", "notes": "tests + lint + build all green"}\n```')
    ];
    expect(extractVerdictFromEvents(events)).toEqual({
      verdict: "PASS",
      notes: "tests + lint + build all green"
    });
  });

  it("extracts a FAIL verdict with specific notes", () => {
    const events = [
      assistantText('```verdict\n{"verdict": "FAIL", "notes": "missing test for src/foo.js:12"}\n```')
    ];
    expect(extractVerdictFromEvents(events)).toEqual({
      verdict: "FAIL",
      notes: "missing test for src/foo.js:12"
    });
  });

  it("falls back to a result event's result field when there's no assistant text block", () => {
    const events = [{ type: "result", result: '```verdict\n{"verdict": "PASS", "notes": "ok"}\n```' }];
    expect(extractVerdictFromEvents(events)).toEqual({ verdict: "PASS", notes: "ok" });
  });

  it("uses the last verdict block when the agent second-guesses itself mid-run", () => {
    const events = [
      assistantText('```verdict\n{"verdict": "FAIL", "notes": "first pass"}\n```'),
      assistantText('```verdict\n{"verdict": "PASS", "notes": "actually fine on second look"}\n```')
    ];
    expect(extractVerdictFromEvents(events)).toEqual({
      verdict: "PASS",
      notes: "actually fine on second look"
    });
  });

  it("returns null when no verdict block is present at all", () => {
    const events = [assistantText("I looked at the diff but forgot to emit a verdict.")];
    expect(extractVerdictFromEvents(events)).toBeNull();
  });

  it("returns null when the verdict block is not valid JSON", () => {
    const events = [assistantText("```verdict\nnot json\n```")];
    expect(extractVerdictFromEvents(events)).toBeNull();
  });

  it('returns null when "verdict" is neither PASS nor FAIL', () => {
    const events = [assistantText('```verdict\n{"verdict": "MAYBE", "notes": "unsure"}\n```')];
    expect(extractVerdictFromEvents(events)).toBeNull();
  });

  it("defaults notes to an empty string when omitted", () => {
    const events = [assistantText('```verdict\n{"verdict": "PASS"}\n```')];
    expect(extractVerdictFromEvents(events)).toEqual({ verdict: "PASS", notes: "" });
  });

  it("returns null for an empty events array", () => {
    expect(extractVerdictFromEvents([])).toBeNull();
  });

  it("ignores non-text content blocks (e.g. tool_use) when scanning for the verdict", () => {
    const events = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "npx vitest run" } },
            { type: "text", text: '```verdict\n{"verdict": "PASS", "notes": "ok"}\n```' }
          ]
        }
      }
    ];
    expect(extractVerdictFromEvents(events)).toEqual({ verdict: "PASS", notes: "ok" });
  });
});
