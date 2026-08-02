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

  it("renders one line per log entry, in order", () => {
    const root = document.createElement("div");
    renderConsolePanel(root, {
      taskId: "T-0001",
      entries: [
        { phase: "implementer", event: { type: "system", subtype: "init" } },
        { phase: "implementer", event: { type: "result", result: "Done." } }
      ]
    });

    const lines = root.querySelectorAll(".console-line");
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain("system: init");
    expect(lines[1].textContent).toContain("Done.");
  });

  it("tags each line with its phase via a class", () => {
    const root = document.createElement("div");
    renderConsolePanel(root, {
      taskId: "T-0001",
      entries: [{ phase: "reviewer", event: { type: "system", subtype: "init" } }]
    });

    const line = root.querySelector(".console-line");
    expect(line.classList.contains("console-line-reviewer")).toBe(true);
  });

  it("clears previously rendered content on re-render", () => {
    const root = document.createElement("div");
    renderConsolePanel(root, {
      taskId: "T-0001",
      entries: [{ phase: "implementer", event: { type: "system", subtype: "init" } }]
    });
    renderConsolePanel(root, { taskId: "T-0001", entries: [] });

    expect(root.querySelectorAll(".console-line")).toHaveLength(0);
  });

  it("shows an empty-state message when the task has no log entries yet", () => {
    const root = document.createElement("div");
    renderConsolePanel(root, { taskId: "T-0001", entries: [] });
    expect(root.textContent.toLowerCase()).toContain("no output yet");
  });
});
