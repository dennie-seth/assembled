// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { renderDetailPanel } from "../../src/client/detailPanel.js";

function task(overrides = {}) {
  return {
    id: "T-0001",
    title: "Sample task",
    status: "backlog",
    priority: "P2",
    phase: 1,
    agent: "infra",
    depends_on: [],
    created: "2026-07-31",
    body: "## Context\nsome context\n\n## Acceptance\n- [ ] do it",
    ...overrides
  };
}

describe("renderDetailPanel", () => {
  it("hides the root and renders nothing when there is no selected task", () => {
    const root = document.createElement("div");
    root.hidden = false;
    renderDetailPanel(root, null, { onSave: vi.fn(), onClose: vi.fn() });
    expect(root.hidden).toBe(true);
    expect(root.children.length).toBe(0);
  });

  it("shows the root and renders the task's title, priority and status", () => {
    const root = document.createElement("div");
    const t = task({ title: "Do the thing", priority: "P0", status: "review" });
    renderDetailPanel(root, t, { onSave: vi.fn(), onClose: vi.fn() });

    expect(root.hidden).toBe(false);
    expect(root.querySelector(".detail-title").value).toBe("Do the thing");
    expect(root.querySelector(".detail-priority").value).toBe("P0");
    expect(root.querySelector(".detail-status").value).toBe("review");
  });

  it("renders the depends_on list", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ depends_on: ["T-0002", "T-0003"] }), {
      onSave: vi.fn(),
      onClose: vi.fn()
    });
    expect(root.querySelector(".detail-deps").textContent).toContain("T-0002");
    expect(root.querySelector(".detail-deps").textContent).toContain("T-0003");
  });

  it("shows a no-dependencies message when depends_on is empty", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ depends_on: [] }), { onSave: vi.fn(), onClose: vi.fn() });
    expect(root.querySelector(".detail-deps").textContent).toMatch(/no dependencies/i);
  });

  it("renders the markdown body as HTML in the preview pane", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task(), { onSave: vi.fn(), onClose: vi.fn() });
    const preview = root.querySelector(".detail-body-preview");
    expect(preview.querySelector("h2").textContent).toBe("Context");
    expect(preview.querySelector(".checklist")).not.toBeNull();
  });

  it("calls onClose when the close button is clicked", () => {
    const root = document.createElement("div");
    const onClose = vi.fn();
    renderDetailPanel(root, task(), { onSave: vi.fn(), onClose });
    root.querySelector(".detail-close").dispatchEvent(new Event("click", { bubbles: true }));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onSave with only the changed fields when Save is clicked", () => {
    const root = document.createElement("div");
    const onSave = vi.fn();
    const t = task({ id: "T-0007" });
    renderDetailPanel(root, t, { onSave, onClose: vi.fn() });

    root.querySelector(".detail-title").value = "Renamed";
    root.querySelector(".detail-priority").value = "P0";
    root.querySelector(".detail-save").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onSave).toHaveBeenCalledWith("T-0007", { title: "Renamed", priority: "P0" });
  });

  it("does not call onSave when nothing was edited", () => {
    const root = document.createElement("div");
    const onSave = vi.fn();
    renderDetailPanel(root, task(), { onSave, onClose: vi.fn() });
    root.querySelector(".detail-save").dispatchEvent(new Event("click", { bubbles: true }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("replaces previously rendered content on re-render", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ id: "T-0001" }), { onSave: vi.fn(), onClose: vi.fn() });
    renderDetailPanel(root, task({ id: "T-0002" }), { onSave: vi.fn(), onClose: vi.fn() });
    expect(root.querySelectorAll(".detail-panel").length).toBe(1);
  });
});
