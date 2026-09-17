// Real-browser proof of T-0288's drag auto-scroll (T-0295). happy-dom -- the fast default for
// every other client test -- performs no layout at all: no viewport, no scroll geometry, and
// `getBoundingClientRect()` is inert, so `dragAutoScroll.test.js` can only ever hand-feed fake
// rects/scrollTop values. This spec drives a real Chromium layout instead: a real `.column-cards`
// scroll container, a real `getBoundingClientRect()`, and a real pointer-driven HTML5 drag.
//
// Separate from `npm test` on purpose -- see package.json's `test:browser` script and
// docs/browser-tests.md. `npm test` (vitest/happy-dom) never touches this file; vitest's own
// `include` glob only matches `test/**/*.test.js`, and this file is `*.spec.js`.
import { test, expect } from "@playwright/test";
import { chromiumLaunchable, chromiumLaunchSkipReason } from "./support/browserAvailability.js";

const FIXTURE_URL = "/test/browser/fixtures/drag-auto-scroll.html";
const COLUMN_SELECTOR = ".column-cards[data-status='backlog']";

test.describe("drag auto-scroll -- real layout (T-0288 proof)", () => {
  test.skip(!chromiumLaunchable(), chromiumLaunchSkipReason());

  test.beforeEach(async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await page.waitForSelector(`${COLUMN_SELECTOR} .card`);
  });

  async function dragCardTo(page, list, targetY) {
    const listBox = await list.boundingBox();
    const cardBox = await list.locator(".card").first().boundingBox();

    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
    await page.mouse.down();
    // A few px of movement first: real HTML5 drag only starts (fires `dragstart`) once the
    // browser's own drag threshold is crossed, not on `mousedown` itself.
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2 + 6, {
      steps: 5
    });
    await page.mouse.move(listBox.x + listBox.width / 2, targetY, { steps: 10 });
  }

  test("dragging into the top hot zone scrolls up and stops at scrollTop 0", async ({ page }) => {
    const list = page.locator(COLUMN_SELECTOR);
    await expect(list).toBeVisible();

    // Start scrolled partway down so there's real room to scroll up.
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight - el.clientHeight;
    });
    const startTop = await list.evaluate((el) => el.scrollTop);
    expect(startTop).toBeGreaterThan(0);

    const listBox = await list.boundingBox();
    await dragCardTo(page, list, listBox.y + 5);

    await expect
      .poll(() => list.evaluate((el) => el.scrollTop), { timeout: 5000 })
      .toBeLessThan(startTop);
    // Stays attached and idles at the limit rather than erroring or overshooting negative.
    await expect.poll(() => list.evaluate((el) => el.scrollTop), { timeout: 5000 }).toBe(0);

    await page.mouse.up();
  });

  test("dragging into the bottom hot zone scrolls down and stops at the bottom limit", async ({
    page
  }) => {
    const list = page.locator(COLUMN_SELECTOR);
    await expect(list).toBeVisible();

    const startTop = await list.evaluate((el) => el.scrollTop);
    expect(startTop).toBe(0);

    const listBox = await list.boundingBox();
    await dragCardTo(page, list, listBox.y + listBox.height - 5);

    await expect
      .poll(() => list.evaluate((el) => el.scrollTop), { timeout: 5000 })
      .toBeGreaterThan(0);

    const maxScrollTop = await list.evaluate((el) => el.scrollHeight - el.clientHeight);
    await expect
      .poll(() => list.evaluate((el) => el.scrollTop), { timeout: 8000 })
      .toBe(maxScrollTop);

    await page.mouse.up();
  });
});

// The `dragleave`/`relatedTarget === null` path (the pointer leaving the browser window
// entirely mid-drag) is deliberately NOT covered here -- see docs/browser-tests.md's
// "Known gap" section for why driving it reliably through CDP-simulated mouse input was not
// achievable, and what was tried.
