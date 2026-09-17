// Real-browser proof that the board fills the viewport in BOTH terminal-panel states.
//
// The regression this pins (measured in Chromium at 800px viewport, 2026-09-04):
//
//   terminal EXPANDED   panel 257px   dead space below the columns:  39px   (fine)
//   terminal COLLAPSED  panel  37px   dead space below the columns: 259px   (the bug)
//
// `body { padding-bottom: 18rem }` reserved a fixed 288px for the terminal panel regardless of
// the panel's actual height. Collapsing the panel to 2.25rem (37px) left ~250px of dead space
// under the columns -- exactly "columns no longer extend to the bottom". The flex chain itself
// (#318) was never broken; the reserved bottom space simply stopped matching reality.
//
// happy-dom cannot catch this: it performs no layout, so every rect is inert and the gap is
// unmeasurable there. This is the T-0295 harness earning its keep.
import { test, expect } from "@playwright/test";
import { chromiumLaunchable, chromiumLaunchSkipReason } from "./support/browserAvailability.js";

const FIXTURE_URL = "/test/browser/fixtures/viewport-fill.html";

/** Space between the lowest column edge and the top of the fixed terminal panel. */
async function deadSpaceBelowColumns(page) {
  return page.evaluate(() => {
    const panelTop = document.getElementById("terminal-panel").getBoundingClientRect().top;
    const lowest = [...document.querySelectorAll(".column")]
      .reduce((m, c) => Math.max(m, c.getBoundingClientRect().bottom), 0);
    return panelTop - lowest;
  });
}

const listGeometry = (page) =>
  page.evaluate(() => {
    const list = document.querySelector(".column-cards[data-status='backlog']")
      || document.querySelector(".column-cards");
    return { scrollH: list.scrollHeight, clientH: list.clientHeight };
  });

// A column's own bottom padding plus the board's leaves a small legitimate gap; anything beyond
// this is reserved-but-unused space, which is the defect.
const MAX_DEAD_SPACE_PX = 60;

test.describe("board fills the viewport in both terminal states", () => {
  test.skip(!chromiumLaunchable(), chromiumLaunchSkipReason());

  test.beforeEach(async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await page.waitForSelector(".column-cards .card");
  });

  test("renders the full column set", async ({ page }) => {
    await expect(page.locator(".column")).toHaveCount(8);
  });

  test("columns reach the terminal panel when it is EXPANDED", async ({ page }) => {
    expect(await deadSpaceBelowColumns(page)).toBeLessThanOrEqual(MAX_DEAD_SPACE_PX);
  });

  test("columns reach the terminal panel when it is COLLAPSED -- the regression", async ({ page }) => {
    await page.click("#terminal-toggle");
    await page.waitForTimeout(300); // the panel's height transition

    const gap = await deadSpaceBelowColumns(page);
    expect(gap, `${gap}px of dead space below the columns with the panel collapsed`)
      .toBeLessThanOrEqual(MAX_DEAD_SPACE_PX);
  });

  test("collapsing the panel GROWS the columns rather than leaving a hole", async ({ page }) => {
    const before = await page.evaluate(() =>
      document.querySelector(".column").getBoundingClientRect().height);

    await page.click("#terminal-toggle");
    await page.waitForTimeout(300);

    const after = await page.evaluate(() =>
      document.querySelector(".column").getBoundingClientRect().height);
    expect(after).toBeGreaterThan(before);
  });

  test("the card list still scrolls INTERNALLY in both states (preserves T-0295)", async ({ page }) => {
    const expanded = await listGeometry(page);
    expect(expanded.scrollH, "list must overflow so drag auto-scroll has room")
      .toBeGreaterThan(expanded.clientH);

    await page.click("#terminal-toggle");
    await page.waitForTimeout(300);

    const collapsed = await listGeometry(page);
    expect(collapsed.scrollH).toBeGreaterThan(collapsed.clientH);
    // the taller column shows more cards at once, but still clips
    expect(collapsed.clientH).toBeGreaterThan(expanded.clientH);
  });

  test("the page itself does not scroll -- the columns absorb the height", async ({ page }) => {
    for (const collapse of [false, true]) {
      if (collapse) {
        await page.click("#terminal-toggle");
        await page.waitForTimeout(300);
      }
      const scrolls = await page.evaluate(() =>
        document.documentElement.scrollHeight > window.innerHeight + 1);
      expect(scrolls, `page scrolled vertically (collapsed=${collapse})`).toBe(false);
    }
  });

  test("holds at a short viewport too", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.waitForTimeout(150);
    await page.click("#terminal-toggle");
    await page.waitForTimeout(300);

    expect(await deadSpaceBelowColumns(page)).toBeLessThanOrEqual(MAX_DEAD_SPACE_PX);
  });
});
