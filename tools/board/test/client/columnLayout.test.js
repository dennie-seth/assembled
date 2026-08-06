// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

// These tests assert the layout fix for T-0141: when the side-panel is visible,
// columns must not shrink (causing text to overlap). The fix is that:
//   1. .column has flex-shrink 0 so it never compresses
//   2. .board has overflow-x: auto so the user can scroll to see all columns
//   3. The body does not add padding-right when side-panel is open
//      (side-panel is position:fixed and overlays instead of pushing)

beforeAll(() => {
  const css = fs.readFileSync(path.join(process.cwd(), "src/client/style.css"), "utf8");
  const styleEl = document.createElement("style");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);
});

describe("board column layout (T-0141 scaling fix)", () => {
  it("board has overflow-x auto so all columns are reachable by horizontal scroll", () => {
    const board = document.createElement("div");
    board.className = "board";
    document.body.appendChild(board);

    expect(getComputedStyle(board).overflowX).toBe("auto");
  });

  it("column flex-shrink is 0 so it never compresses when side-panel overlays", () => {
    const column = document.createElement("div");
    column.className = "column";
    document.body.appendChild(column);

    expect(getComputedStyle(column).flexShrink).toBe("0");
  });

  it("column has a usable minimum width so text is never squeezed to nothing", () => {
    const column = document.createElement("div");
    column.className = "column";
    document.body.appendChild(column);

    // flex-basis is set to 14rem; happy-dom reports it as the basis value
    const flexBasis = getComputedStyle(column).flexBasis;
    // Accept any non-zero, non-auto basis that keeps a column wide enough.
    // 14rem at default 16px font = 224px. happy-dom resolves to px.
    const pxVal = parseFloat(flexBasis);
    expect(pxVal).toBeGreaterThanOrEqual(100);
  });

  it("side-panel is position fixed (overlays board rather than pushing it)", () => {
    const sidePanel = document.createElement("div");
    sidePanel.id = "side-panel";
    document.body.appendChild(sidePanel);

    expect(getComputedStyle(sidePanel).position).toBe("fixed");
  });
});
