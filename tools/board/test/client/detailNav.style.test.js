// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

// T-0462 acceptance: "the jump control does not obscure content." Round 1 of this card
// claimed `position: sticky` alone made overlap impossible -- a reviewer correctly rejected
// that: sticky only reserves flow space at the nav's ORIGINAL position; once #detail (a real
// `overflow-y: auto` scroll container) scrolls past that point, the nav detaches and stays
// pinned at `top: 0` over whatever scrolls underneath it, same as a `fixed` header would.
//
// happy-dom performs no real layout (every getBoundingClientRect is inert), so a pixel-level
// non-overlap proof needs the Playwright real-browser harness under test/browser -- neither
// this card's `infra` grant nor the reviewer's grant can execute `npx playwright`, so that is
// not attempted here, same honest limitation as round 1. What changed is the mitigation itself:
// instead of a false claim that no mitigation was needed, every navigable landmark now carries
// `scroll-margin-top: var(--detail-nav-scroll-margin)` (style.css), which IS something this
// computed-style test can verify, and which `scrollIntoView` (CSSOM View spec) honours when
// `stepDetailSection`/`focusDetailSection` jump to a section.
beforeAll(() => {
  const css = fs.readFileSync(path.join(process.cwd(), "src/client/style.css"), "utf8");
  const styleEl = document.createElement("style");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);
});

describe("detail-nav (T-0462 section nav bar) does not obscure content", () => {
  it("uses position: sticky, not fixed/absolute -- it occupies flow space at its own position", () => {
    const nav = document.createElement("div");
    nav.className = "detail-nav";
    document.body.appendChild(nav);
    expect(getComputedStyle(nav).position).toBe("sticky");
  });

  it("sticks to the very top of its scroll container", () => {
    const nav = document.createElement("div");
    nav.className = "detail-nav";
    document.body.appendChild(nav);
    expect(getComputedStyle(nav).top).toBe("0px");
  });

  it("wraps onto a second line at a narrow width instead of overflowing its own box", () => {
    const nav = document.createElement("div");
    nav.className = "detail-nav";
    document.body.appendChild(nav);
    expect(getComputedStyle(nav).flexWrap).toBe("wrap");
  });

  it("states a concrete single-line reserved height -- not left to the browser's default button/select sizing", () => {
    const nav = document.createElement("div");
    nav.className = "detail-nav";
    document.body.appendChild(nav);
    // This is the number the acceptance criterion asks to state: the bar reserves 2.5rem (40px
    // at the default 16px root font) for its single-line layout. happy-dom resolves computed
    // length values to px, not the authored unit -- --detail-nav-scroll-margin (below) is
    // pinned to double this.
    expect(getComputedStyle(nav).minHeight).toBe("40px");
  });

  it("gives every navigable landmark a scroll-margin-top that clears the sticky bar, including its wrapped (narrow-width, two-line) height", () => {
    const target = document.createElement("div");
    target.dataset.detailSection = "composer";
    document.body.appendChild(target);
    // Double the single-line nav height (5rem) -- covers the ~2x-taller wrapped state at a
    // narrow width without having to detect viewport width at scroll time. happy-dom returns
    // this particular computed property unresolved (as authored), unlike minHeight above.
    expect(getComputedStyle(target).scrollMarginTop).toBe("5rem");
  });

  it("applies the same scroll-margin-top to every section kind, not only the ones named in the acceptance criteria", () => {
    for (const key of ["top", "body", "acceptance", "comments", "composer", "attachments"]) {
      const target = document.createElement("div");
      target.dataset.detailSection = key;
      document.body.appendChild(target);
      expect(getComputedStyle(target).scrollMarginTop).toBe("5rem");
    }
  });
});
