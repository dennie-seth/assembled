// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { createDepsPicker } from "../../src/client/depsPicker.js";

function tasks() {
  return [
    { id: "T-0001", title: "First task" },
    { id: "T-0002", title: "Second task" },
    { id: "T-0003", title: "Third task" }
  ];
}

describe("createDepsPicker dropdown", () => {
  it("populates the dropdown with all available tasks as 'T-NNNN — title' when nothing is selected", () => {
    const picker = createDepsPicker({ availableTasks: tasks() });
    const select = picker.element.querySelector(".deps-picker-select");
    const labels = Array.from(select.options)
      .filter((opt) => opt.value !== "")
      .map((opt) => opt.textContent);
    expect(labels).toEqual(["T-0001 — First task", "T-0002 — Second task", "T-0003 — Third task"]);
  });

  it("excludes already-selected tasks from the dropdown", () => {
    const picker = createDepsPicker({ availableTasks: tasks(), selectedIds: ["T-0002"] });
    const select = picker.element.querySelector(".deps-picker-select");
    const values = Array.from(select.options).map((opt) => opt.value).filter(Boolean);
    expect(values).toEqual(["T-0001", "T-0003"]);
  });

  it("never offers excludeId (self) as a dropdown option", () => {
    const picker = createDepsPicker({ availableTasks: tasks(), excludeId: "T-0002" });
    const select = picker.element.querySelector(".deps-picker-select");
    const values = Array.from(select.options).map((opt) => opt.value).filter(Boolean);
    expect(values).not.toContain("T-0002");
  });

  it("dedupes initial selectedIds", () => {
    const picker = createDepsPicker({ availableTasks: tasks(), selectedIds: ["T-0001", "T-0001"] });
    expect(picker.getSelected()).toEqual(["T-0001"]);
  });

  it("drops excludeId from initial selectedIds even if present (no self-dependency)", () => {
    const picker = createDepsPicker({ availableTasks: tasks(), excludeId: "T-0001", selectedIds: ["T-0001", "T-0002"] });
    expect(picker.getSelected()).toEqual(["T-0002"]);
  });
});

describe("createDepsPicker selection via dropdown", () => {
  it("selecting an option in the dropdown adds it as a chip and removes it from the dropdown", () => {
    const picker = createDepsPicker({ availableTasks: tasks() });
    const select = picker.element.querySelector(".deps-picker-select");

    select.value = "T-0002";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(picker.getSelected()).toEqual(["T-0002"]);
    const chips = picker.element.querySelectorAll(".deps-chip");
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toContain("T-0002 — Second task");

    const remainingValues = Array.from(select.options).map((opt) => opt.value).filter(Boolean);
    expect(remainingValues).toEqual(["T-0001", "T-0003"]);
  });

  it("resets the dropdown to the placeholder after adding a selection", () => {
    const picker = createDepsPicker({ availableTasks: tasks() });
    const select = picker.element.querySelector(".deps-picker-select");

    select.value = "T-0001";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(select.value).toBe("");
  });

  it("selecting the empty placeholder value does nothing", () => {
    const picker = createDepsPicker({ availableTasks: tasks() });
    const select = picker.element.querySelector(".deps-picker-select");

    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(picker.getSelected()).toEqual([]);
  });
});

describe("createDepsPicker chip removal", () => {
  it("clicking a chip's remove button deletes it from the selection", () => {
    const picker = createDepsPicker({ availableTasks: tasks(), selectedIds: ["T-0001", "T-0002"] });

    const chip = picker.element.querySelector('.deps-chip[data-id="T-0001"]');
    chip.querySelector(".deps-chip-remove").dispatchEvent(new Event("click", { bubbles: true }));

    expect(picker.getSelected()).toEqual(["T-0002"]);
  });

  it("makes a removed dependency reappear as an available dropdown option", () => {
    const picker = createDepsPicker({ availableTasks: tasks(), selectedIds: ["T-0001", "T-0002"] });

    const chip = picker.element.querySelector('.deps-chip[data-id="T-0001"]');
    chip.querySelector(".deps-chip-remove").dispatchEvent(new Event("click", { bubbles: true }));

    const select = picker.element.querySelector(".deps-picker-select");
    const values = Array.from(select.options).map((opt) => opt.value).filter(Boolean);
    expect(values).toContain("T-0001");
  });

  it("renders a chip with an accessible remove label naming the dependency", () => {
    const picker = createDepsPicker({ availableTasks: tasks(), selectedIds: ["T-0001"] });
    const removeBtn = picker.element.querySelector(".deps-chip-remove");
    expect(removeBtn.getAttribute("aria-label")).toMatch(/T-0001/);
  });

  it("falls back to the bare id as chip label when the task isn't in availableTasks", () => {
    const picker = createDepsPicker({ availableTasks: [], selectedIds: ["T-0099"] });
    const chip = picker.element.querySelector('.deps-chip[data-id="T-0099"]');
    expect(chip.textContent).toContain("T-0099");
  });
});
