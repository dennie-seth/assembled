// Drag auto-scroll for `.column-cards` (T-0288). Before this module there was no auto-scroll
// at all -- the column's `dragover` handler was a bare `event.preventDefault()` and nothing in
// the client called `scrollBy`. What was being felt was the browser's own native HTML5 drag
// auto-scroll: a narrow band right at the edge, unreliable inside a nested scroll container.

// A real band, not a sliver: a proportion of the container's height with a comfortable floor,
// clamped so the top and bottom bands can never meet in a short column (which would make every
// position scroll and the column unusable).
export const MIN_HOT_ZONE_PX = 64;
export const HOT_ZONE_RATIO = 0.15;
export const MAX_HOT_ZONE_RATIO = 1 / 3;

// Velocity ramp (a plus, not required by the card, but cheap once the depth is already computed
// for the hot-zone check): the deeper into the band the pointer/card edge sits, the faster it
// scrolls.
export const MIN_SCROLL_SPEED_PX = 4;
export const MAX_SCROLL_SPEED_PX = 20;

/**
 * The hot-zone size for a container of the given height: `max(MIN_HOT_ZONE_PX, 15% of height)`,
 * clamped to at most a third of the height so the two bands never overlap.
 */
export function hotZoneSize(containerHeight) {
  if (containerHeight <= 0) return 0;
  const withFloor = Math.max(MIN_HOT_ZONE_PX, containerHeight * HOT_ZONE_RATIO);
  return Math.min(withFloor, containerHeight * MAX_HOT_ZONE_RATIO);
}

function speedForDepth(depth, band) {
  if (band <= 0) return MIN_SCROLL_SPEED_PX;
  const ratio = Math.max(0, Math.min(1, depth / band));
  return MIN_SCROLL_SPEED_PX + ratio * (MAX_SCROLL_SPEED_PX - MIN_SCROLL_SPEED_PX);
}

/**
 * Given a scroll container's rect, the pointer's viewport Y, and (optionally) the dragged
 * card's offset, decides whether the container should auto-scroll this frame.
 *
 * Trigger source: the dragged card's own leading edge, derived from the pointer position and
 * the grab offset captured at `dragstart` -- NOT `draggedElement.getBoundingClientRect()`.
 * During a native HTML5 drag the source element never moves (it stays in normal flow) and the
 * drag image is a detached snapshot with no queryable rect, so reading the source element's own
 * rect each frame reports where the card *was* at drag start, not where it's being dragged. The
 * browser keeps the drag image's offset from the cursor fixed at the grab point, so
 * `pointerY - grabOffsetY` (top) / `+ height` (bottom) tracks the visible card precisely and
 * collapses to the pointer position alone for a card exactly at the cursor. This directly fixes
 * a VALIDATION FAIL: the old stale-rect version could pick the wrong direction entirely and
 * stall/oscillate around the source card's original position for a tall card (see
 * dragAutoScroll.test.js's regression test for the exact counterexample).
 *
 * @returns {{direction: 'up'|'down'|null, speed: number}} speed is 0 when direction is null.
 */
export function computeAutoScroll({ containerRect, pointerY, cardOffset = null, scrollTop, scrollHeight, clientHeight }) {
  const band = hotZoneSize(containerRect.height);
  const leadingTop = cardOffset ? pointerY - cardOffset.grabOffsetY : pointerY;
  const leadingBottom = cardOffset ? leadingTop + cardOffset.height : pointerY;

  const topDepth = band - (leadingTop - containerRect.top);
  const bottomDepth = band - (containerRect.bottom - leadingBottom);
  const canScrollUp = scrollTop > 0;
  const canScrollDown = scrollTop + clientHeight < scrollHeight;

  const candidates = [];
  if (topDepth > 0 && canScrollUp) candidates.push({ direction: "up", depth: topDepth });
  if (bottomDepth > 0 && canScrollDown) candidates.push({ direction: "down", depth: bottomDepth });

  if (candidates.length === 0) {
    return { direction: null, speed: 0 };
  }

  // A very tall card can overlap both bands at once; the deeper overlap is the more urgent one.
  const winner = candidates.reduce((a, b) => (b.depth > a.depth ? b : a));
  return { direction: winner.direction, speed: speedForDepth(winner.depth, band) };
}

/**
 * Drives `computeAutoScroll` on an animation frame rather than per-`dragover`-event (dragover
 * fires very frequently; doing the scroll work there would be jittery and CPU-heavy). Callers
 * feed it the latest pointer position via `update()` on every `dragover`; the actual
 * `getBoundingClientRect()`/`scrollBy()` work only happens inside the rAF-driven `tick`.
 *
 * `requestFrame`/`cancelFrame` are injectable so the loop is unit-testable without a real
 * animation-frame clock; they default to the real `requestAnimationFrame`/`cancelAnimationFrame`.
 */
export function createAutoScrollController({
  requestFrame = (cb) => requestAnimationFrame(cb),
  cancelFrame = (id) => cancelAnimationFrame(id)
} = {}) {
  let container = null;
  let pointerY = null;
  let cardOffset = null;
  let frameId = null;

  function tick() {
    frameId = null;
    if (!container) return;

    if (pointerY !== null) {
      const containerRect = container.getBoundingClientRect();
      const result = computeAutoScroll({
        containerRect,
        pointerY,
        cardOffset,
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight
      });
      if (result.direction === "up") {
        container.scrollBy(0, -result.speed);
      } else if (result.direction === "down") {
        container.scrollBy(0, result.speed);
      }
    }

    frameId = requestFrame(tick);
  }

  return {
    /** Begin (or continue) auto-scrolling `nextContainer`. Idempotent while already attached. */
    attach(nextContainer) {
      container = nextContainer;
      if (frameId === null) {
        frameId = requestFrame(tick);
      }
    },
    /**
     * Latest pointer Y (viewport coords) and the dragged card's offset (`{grabOffsetY, height}`,
     * captured at `dragstart` -- see boardView.js), read by the next tick.
     */
    update(nextPointerY, nextCardOffset = null) {
      pointerY = nextPointerY;
      cardOffset = nextCardOffset;
    },
    /** Stop scrolling and cancel any pending frame. Safe to call when not attached. */
    detach() {
      container = null;
      pointerY = null;
      cardOffset = null;
      if (frameId !== null) {
        cancelFrame(frameId);
        frameId = null;
      }
    },
    isAttached() {
      return container !== null;
    }
  };
}
