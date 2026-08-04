// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createDepsPicker } from "../../src/client/depsPicker.js";

// These tests load the real style.css into happy-dom's CSSOM and assert on
// getComputedStyle, because the underlying bug is a cascade issue: the deps
// picker's <select> sizes to its widest option ("T-NNNN — long title") and
// overflows the card instead of respecting the form width like every other
// create-form field.

beforeAll(() => {
  const css = fs.readFileSync(path.join(process.cwd(), "src/client/style.css"), "utf8");
  const styleEl = document.createElement("style");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);
});

function mountInForm(element) {
  const form = document.createElement("div");
  form.className = "create-form";
  const field = document.createElement("label");
  field.className = "detail-field";
  field.appendChild(element);
  form.appendChild(field);
  document.body.appendChild(form);
  return form;
}

describe("deps picker layout", () => {
  it("constrains the select to the form width instead of its widest option", () => {
    const picker = createDepsPicker({
      availableTasks: [{ id: "T-0099", title: "A very long title that would otherwise widen the select" }]
    });
    mountInForm(picker.element);

    const select = picker.element.querySelector(".deps-picker-select");
    const cs = getComputedStyle(select);
    expect(cs.width).toBe("100%");
    expect(cs.maxWidth).toBe("100%");
    expect(cs.boxSizing).toBe("border-box");
  });

  it("keeps the deps-picker container from overflowing its own width", () => {
    const picker = createDepsPicker({ availableTasks: [] });
    mountInForm(picker.element);

    const cs = getComputedStyle(picker.element);
    expect(cs.boxSizing).toBe("border-box");
    expect(cs.maxWidth).toBe("100%");
  });
});
