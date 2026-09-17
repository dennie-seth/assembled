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

    // flex-basis is set to 14rem. happy-dom keeps rem units without resolving
    // to px, so we check the numeric part (>=10rem is meaningfully wide).
    const flexBasis = getComputedStyle(column).flexBasis;
    const remVal = parseFloat(flexBasis);
    expect(remVal).toBeGreaterThanOrEqual(10);
  });

  it("side-panel is position fixed (overlays board rather than pushing it)", () => {
    const sidePanel = document.createElement("div");
    sidePanel.id = "side-panel";
    document.body.appendChild(sidePanel);

    expect(getComputedStyle(sidePanel).position).toBe("fixed");
  });
});

// T-0288 VALIDATION FAIL (run 1): `.column-cards` had no `overflow-y`/bounded height at all
// (min-height/display/flex-direction/gap only), so in a real browser scrollHeight === clientHeight
// and scrollTop is always 0 -- the auto-scroll math in dragAutoScroll.js can never find room to
// scroll no matter how the pointer moves. This pins the container the drag auto-scroll targets
// as an actual scrollable box, independent of the scroll math itself (covered separately in
// dragAutoScroll.test.js).
//
// The FIRST fix bounded it with `max-height: 60vh`, which regressed the layout: every column
// became 60% of the viewport whatever space was available, so cards never reached the bottom of
// the window and nothing scaled on resize. The bound now comes from a full-height flex chain
// (body -> #board -> .board -> .column -> .column-cards) instead, so these tests pin the chain
// rather than a fixed cap -- the height is still definite, so it is still a real scroll container.
describe("column-cards is a real scroll container (T-0288 drag auto-scroll)", () => {
  it("is vertically scrollable and grows to fill its column rather than being capped", () => {
    const column = document.createElement("div");
    column.className = "column";
    const list = document.createElement("div");
    list.className = "column-cards";
    column.appendChild(list);
    document.body.appendChild(column);

    const style = getComputedStyle(list);
    expect(style.overflowY).toBe("auto");
    // grows into the space the column gives it
    expect(style.flexGrow).toBe("1");
    // a DEFINITE (not `auto`) min-height is what lets a flex item shrink below its content
    // and scroll; `auto` would resolve to the content height and overflow the column instead.
    expect(style.minHeight).not.toBe("auto");
    expect(style.minHeight).not.toBe("");
  });

  it("the column is a flex column with min-height 0 so the card list can scroll inside it", () => {
    const column = document.createElement("div");
    column.className = "column";
    document.body.appendChild(column);

    const style = getComputedStyle(column);
    expect(style.display).toBe("flex");
    expect(style.flexDirection).toBe("column");
    // min-height: 0 on the ancestor is the critical bit -- without it the automatic minimum
    // size is the content height and the list overflows instead of scrolling.
    expect(["0", "0px"]).toContain(style.minHeight);
  });

  it("the board stretches its columns so they reach the bottom of the viewport", () => {
    const board = document.createElement("div");
    board.className = "board";
    document.body.appendChild(board);

    const style = getComputedStyle(board);
    // `flex-start` (the pre-fix value) sized each column to its content, which is why cards
    // stopped short of the bottom.
    expect(style.alignItems).toBe("stretch");
    expect(["0", "0px"]).toContain(style.minHeight);
  });

  it("the page root establishes a viewport-height flex chain", () => {
    const style = getComputedStyle(document.body);
    expect(style.display).toBe("flex");
    expect(style.flexDirection).toBe("column");
    // T-0295: must be `height`, not `min-height` -- `min-height` lets the box grow to fit
    // content instead of clipping to the viewport, which is exactly the bug a real-browser
    // test caught (see style.css's body rule comment). happy-dom resolves 100dvh/100vh to a
    // definite px value (its default viewport height) rather than keeping the unit string, so
    // just assert it is a definite length -- not "auto", which is what a `min-height`-only box
    // reports.
    expect(style.height).toMatch(/^\d+px$/);
  });
});
