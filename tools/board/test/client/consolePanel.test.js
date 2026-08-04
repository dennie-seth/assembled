// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderConsolePanel } from "../../src/client/consolePanel.js";

describe("renderConsolePanel", () => {
  it("hides the panel when no task is selected", () => {
    const root = document.createElement("div");
    renderConsolePanel(root, { taskId: null, entries: [] });
    expect(root.hidden).toBe(true);
  });

  it("shows the panel and heading for the selected task", () => {
    const root = document.createElement("div");
    renderConsolePanel(root, { taskId: "T-0001", entries: [] });
    expect(root.hidden).toBe(false);
    expect(root.textContent).toContain("T-0001");
  });

  it("renders one line per renderable log entry, in order", () => {
    const root = document.createElement("div");
    renderConsolePanel(root, {
      taskId: "T-0001",
      entries: [
        { phase: "implementer", event: { type: "assistant", message: { content: [{ type: "text", text: "Starting." }] } } },
        { phase: "implementer", event: { type: "result", result: "Done." } }
      ]
    });

    const lines = root.querySelectorAll(".console-line");
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain("Starting.");
    expect(lines[1].textContent).toContain("Done.");
  });

  it("skips noise envelopes (system/init) entirely, rendering no line for them", () => {
    const root = document.createElement("div");
    renderConsolePanel(root, {
      taskId: "T-0001",
      entries: [
        { phase: "implementer", event: { type: "system", subtype: "init" } },
        { phase: "implementer", event: { type: "assistant", message: { content: [{ type: "text", text: "Hi." }] } } }
      ]
    });

    const lines = root.querySelectorAll(".console-line");
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain("Hi.");
  });

  it("expands a single assistant event with text and a tool call into multiple lines", () => {
    const root = document.createElement("div");
    renderConsolePanel(root, {
      taskId: "T-0001",
      entries: [
        {
          phase: "implementer",
          event: {
            type: "assistant",
            message: {
              content: [
                { type: "text", text: "Running the suite." },
                { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }
              ]
            }
          }
        }
      ]
    });

    const lines = root.querySelectorAll(".console-line");
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain("Running the suite.");
    expect(lines[1].textContent).toContain("→ Bash: npm test");
  });

  it("correlates a tool_result line back to the tool name from an earlier tool_use in the same log", () => {
    const root = document.createElement("div");
    renderConsolePanel(root, {
      taskId: "T-0001",
      entries: [
        {
          phase: "implementer",
          event: { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } }
        },
        {
          phase: "implementer",
          event: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }
        }
      ]
    });

    const lines = root.querySelectorAll(".console-line");
    expect(lines).toHaveLength(2);
    expect(lines[1].textContent).toContain("✓ Bash: ok");
  });

  it("tags each line with its phase via a class", () => {
    const root = document.createElement("div");
    renderConsolePanel(root, {
      taskId: "T-0001",
      entries: [{ phase: "reviewer", event: { type: "result", result: "Done." } }]
    });

    const line = root.querySelector(".console-line");
    expect(line.classList.contains("console-line-reviewer")).toBe(true);
  });

  it("clears previously rendered content on re-render", () => {
    const root = document.createElement("div");
    renderConsolePanel(root, {
      taskId: "T-0001",
      entries: [{ phase: "implementer", event: { type: "result", result: "Done." } }]
    });
    renderConsolePanel(root, { taskId: "T-0001", entries: [] });

    expect(root.querySelectorAll(".console-line")).toHaveLength(0);
  });

  it("shows an empty-state message when the task has no log entries yet", () => {
    const root = document.createElement("div");
    renderConsolePanel(root, { taskId: "T-0001", entries: [] });
    expect(root.textContent.toLowerCase()).toContain("no output yet");
  });

  it("shows the empty-state message when entries exist but are all noise", () => {
    const root = document.createElement("div");
    renderConsolePanel(root, {
      taskId: "T-0001",
      entries: [{ phase: "implementer", event: { type: "system", subtype: "init" } }]
    });
    expect(root.textContent.toLowerCase()).toContain("no output yet");
  });
});
