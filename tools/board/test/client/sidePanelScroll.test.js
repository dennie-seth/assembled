// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Tests for T-0142: guarantee every card is reachable by scrolling when the
// side-panel is open, regardless of column count.
//
// Root cause: T-0141 set overflow-x:auto on .board, but overflow only appears
// when columns naturally exceed the viewport width. With few columns the board
// doesn't overflow, so the last column can sit behind the fixed, overlaying
// side-panel with no scrollbar to reach it.
//
// Fix: when the side-panel is visible, .board gets padding-right: 28rem
// (matching the side-panel width). This guarantees the board's scrollable
// content overflows by at least the panel width, so the user can always scroll
// the last column clear of the overlay.
//
// Mathematical basis: at max scroll position,
//   lastColRightEdge_in_viewport = clientWidth - paddingRight
// For paddingRight = panelWidth: the last column's right edge lands exactly at
// the panel's left edge — fully visible, not behind it. Proof:
//   scrollWidth   = colsWidth + paddingRight
//   scrollMax     = scrollWidth - clientWidth
//   afterMaxScroll position of last column right edge
//               = colsWidth - scrollMax
//               = colsWidth - (colsWidth + paddingRight - clientWidth)
//               = clientWidth - paddingRight
// With paddingRight = panelWidth: result = clientWidth - panelWidth = panel left edge.

beforeAll(() => {
  const css = fs.readFileSync(path.join(process.cwd(), "src/client/style.css"), "utf8");
  const styleEl = document.createElement("style");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);
});

beforeEach(() => {
  document.body.innerHTML = "";
});

function makeSidePanel({ hidden = false } = {}) {
  const el = document.createElement("div");
  el.id = "side-panel";
  if (hidden) el.setAttribute("hidden", "");
  return el;
}

function makeBoard(numCols) {
  const board = document.createElement("div");
  board.className = "board";
  for (let i = 0; i < numCols; i++) {
    const col = document.createElement("div");
    col.className = "column";
    board.appendChild(col);
  }
  return board;
}

describe("side-panel scroll reachability (T-0142)", () => {
  it("few columns + panel open: board has 28rem right padding so the last column is not permanently hidden", () => {
    // Few columns = fewer than would naturally overflow the viewport.
    // Without the fix, no scrollbar appears and the last column is stuck behind the panel.
    // The padding-right must be the full 28rem panel width (not just > 0).
    const panel = makeSidePanel({ hidden: false });
    const board = makeBoard(2);
    document.body.append(panel, board);

    const paddingRight = getComputedStyle(board).paddingRight;
    // happy-dom returns rem values as-is (e.g. "28rem").
    // parseFloat("28rem") = 28; parseFloat("") = NaN; parseFloat("0px") = 0.
    const remValue = parseFloat(paddingRight);
    expect(remValue).toBeGreaterThanOrEqual(28);
  });

  it("many columns + panel open: board retains 28rem right padding so all columns are reachable in both directions", () => {
    // Regression guard for T-0141: many columns still get the extra padding.
    const panel = makeSidePanel({ hidden: false });
    const board = makeBoard(8);
    document.body.append(panel, board);

    const paddingRight = getComputedStyle(board).paddingRight;
    const remValue = parseFloat(paddingRight);
    expect(remValue).toBeGreaterThanOrEqual(28);
  });

  it("panel closed: board has no extra right padding so no spurious scrollbar appears", () => {
    // When the panel is hidden the overlay is gone; the conditional rule
    // body:has(#side-panel:not([hidden])) .board must NOT apply.
    // happy-dom returns "" for properties with no applied rule (no inline or
    // stylesheet value), so we accept both "" and "0px" as "not set".
    const panel = makeSidePanel({ hidden: true });
    const board = makeBoard(2);
    document.body.append(panel, board);

    const paddingRight = getComputedStyle(board).paddingRight;
    const remValue = parseFloat(paddingRight);
    // NaN (empty string) and 0 both mean no padding was applied.
    expect(remValue > 0).toBe(false);
  });

  it("panel open: right padding value is exactly 28rem so the last column clears the side-panel at max scroll", () => {
    // The side-panel is min(28rem, 100%) wide; for any typical viewport this is
    // 28rem. padding-right must equal that value so at max scroll the last
    // column's right edge lands at the panel's left edge (see math in header).
    const panel = makeSidePanel({ hidden: false });
    const board = makeBoard(3);
    document.body.append(panel, board);

    const paddingRight = getComputedStyle(board).paddingRight;
    // happy-dom returns rem values numerically (e.g. "28rem" → parseFloat = 28).
    const remValue = parseFloat(paddingRight);
    expect(remValue).toBe(28);
  });
});
