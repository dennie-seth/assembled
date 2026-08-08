// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Tests for T-0142/side-panel-reflow: guarantee every column stays visible
// (not painted under the fixed panel) when the side-panel is open, regardless
// of column count or scroll position.
//
// Root cause (T-0141): .board got padding-right: 28rem when the panel opened.
// Padding only extends the *scrollable content*, so it helps once you scroll
// there — it does nothing for columns already onscreen at the current scroll
// position, which end up painted under the fixed, overlaying side-panel.
//
// Fix: when the side-panel is visible, .board gets margin-right: 28rem
// instead — this shrinks the board's own visible box so its right edge
// reflows to meet the panel's left edge, at any scroll position. Gated
// behind a `min-width: 28rem` media query to match the panel's own
// min(28rem, 100%) width formula: below that breakpoint the panel already
// covers the full viewport, so shrinking the board further is unnecessary.

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

describe("side-panel reflow (T-0142 / side-panel-reflow)", () => {
  it("few columns + panel open: board gets 28rem right margin so columns reflow clear of the panel", () => {
    // Few columns = fewer than would naturally overflow the viewport. Under the old
    // padding-right approach these never scrolled, so they sat permanently behind
    // the panel. margin-right must apply regardless of column count.
    const panel = makeSidePanel({ hidden: false });
    const board = makeBoard(2);
    document.body.append(panel, board);

    // happy-dom resolves rem to px at 16px/rem (28rem -> "448px").
    const marginRight = parseFloat(getComputedStyle(board).marginRight);
    expect(marginRight).toBeGreaterThanOrEqual(448);
  });

  it("many columns + panel open: board still gets 28rem right margin", () => {
    // Regression guard for T-0141: many columns still get the reflow margin.
    const panel = makeSidePanel({ hidden: false });
    const board = makeBoard(8);
    document.body.append(panel, board);

    const marginRight = parseFloat(getComputedStyle(board).marginRight);
    expect(marginRight).toBeGreaterThanOrEqual(448);
  });

  it("panel closed: board has no extra right margin so it uses the full available width", () => {
    // When the panel is hidden the overlay is gone; the conditional rule
    // body:has(#side-panel:not([hidden])) .board must NOT apply.
    // happy-dom returns "" for properties with no applied rule (no inline or
    // stylesheet value), so we accept both "" and "0px" as "not set".
    const panel = makeSidePanel({ hidden: true });
    const board = makeBoard(2);
    document.body.append(panel, board);

    const marginRight = getComputedStyle(board).marginRight;
    const value = parseFloat(marginRight);
    // NaN (empty string) and 0 both mean no margin was applied.
    expect(value > 0).toBe(false);
  });

  it("panel open: margin-right value is at least 28rem so columns fully clear the panel's left edge", () => {
    // The side-panel is min(28rem, 100%) wide; margin-right must be >= that
    // value so the board's visible right edge lands at (or left of) the
    // panel's left edge, at any scroll position -- not just at max scroll.
    const panel = makeSidePanel({ hidden: false });
    const board = makeBoard(3);
    document.body.append(panel, board);

    const marginRight = parseFloat(getComputedStyle(board).marginRight);
    expect(marginRight).toBeGreaterThanOrEqual(448);
  });

  it("narrow viewport (<28rem): the reflow margin does not apply, since the panel already goes full-width and covers the board regardless", () => {
    // Below the min-width: 28rem breakpoint, #side-panel's own
    // min(28rem, 100%) width formula switches to 100% (full viewport), so it
    // already covers the entire board. Applying margin-right there too would
    // just collapse the board for no benefit once the panel closes again.
    window.happyDOM.setViewport({ width: 320 });
    try {
      const panel = makeSidePanel({ hidden: false });
      const board = makeBoard(2);
      document.body.append(panel, board);

      const marginRight = getComputedStyle(board).marginRight;
      const value = parseFloat(marginRight);
      expect(value > 0).toBe(false);
    } finally {
      window.happyDOM.setViewport({ width: 1024 });
    }
  });
});
