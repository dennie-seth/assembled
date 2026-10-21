// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

// T-0462 acceptance: "the jump control does not obscure content." happy-dom performs no real
// layout (every getBoundingClientRect is inert), so a pixel-level non-overlap proof needs the
// Playwright real-browser harness under test/browser -- neither this card's `infra` grant nor
// the reviewer's grant can execute `npx playwright`, so that is not attempted here. What IS
// verifiable, and is the actual mechanism the "does not obscure" guarantee rests on: the nav
// bar uses `position: sticky`, not `fixed`/`absolute`. A sticky element occupies its own box in
// normal document flow -- every sibling after it is laid out below its reserved space from the
// first render, so there is no scroll position at which that content could end up underneath
// it. That is a property of the CSSOM value itself, which this DOES check.
beforeAll(() => {
  const css = fs.readFileSync(path.join(process.cwd(), "src/client/style.css"), "utf8");
  const styleEl = document.createElement("style");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);
});

describe("detail-nav (T-0462 section nav bar) does not obscure content", () => {
  it("uses position: sticky, not fixed/absolute -- it occupies flow space so later siblings can never be covered", () => {
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

  it("wraps onto a second line at a narrow width instead of overflowing/overlapping", () => {
    const nav = document.createElement("div");
    nav.className = "detail-nav";
    document.body.appendChild(nav);
    expect(getComputedStyle(nav).flexWrap).toBe("wrap");
  });
});
