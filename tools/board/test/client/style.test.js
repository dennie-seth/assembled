// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

// These tests load the real style.css into happy-dom's CSSOM and assert on
// getComputedStyle, because the underlying bug here is a cascade issue that
// the detailPanel.js unit tests can't see (they only observe the `hidden`
// IDL property, not what actually paints).

beforeAll(() => {
  const css = fs.readFileSync(path.join(process.cwd(), "src/client/style.css"), "utf8");
  const styleEl = document.createElement("style");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);
});

describe("detail-delete-confirm [hidden] cascade", () => {
  it("is not painted when the hidden attribute is set", () => {
    const el = document.createElement("div");
    el.className = "detail-delete-confirm";
    el.hidden = true;
    document.body.appendChild(el);

    expect(getComputedStyle(el).display).toBe("none");
  });

  it("is painted as a flex row once the hidden attribute is removed", () => {
    const el = document.createElement("div");
    el.className = "detail-delete-confirm";
    document.body.appendChild(el);

    expect(getComputedStyle(el).display).toBe("flex");
  });
});

describe("card-rerun CSS styling", () => {
  it("has the same cursor as card-run (not unstyled browser default)", () => {
    const runBtn = document.createElement("button");
    runBtn.className = "card-run";
    const rerunBtn = document.createElement("button");
    rerunBtn.className = "card-rerun";
    document.body.append(runBtn, rerunBtn);

    expect(getComputedStyle(rerunBtn).cursor).toBe("pointer");
    expect(getComputedStyle(rerunBtn).cursor).toBe(getComputedStyle(runBtn).cursor);
  });

  it("has the same border-radius as card-run", () => {
    const runBtn = document.createElement("button");
    runBtn.className = "card-run";
    const rerunBtn = document.createElement("button");
    rerunBtn.className = "card-rerun";
    document.body.append(runBtn, rerunBtn);

    expect(getComputedStyle(rerunBtn).borderRadius).toBe(getComputedStyle(runBtn).borderRadius);
  });
});
