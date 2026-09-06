import { describe, it, expect, vi } from "vitest";
import {
  hotZoneSize,
  computeAutoScroll,
  createAutoScrollController,
  MIN_SCROLL_SPEED_PX,
  MAX_SCROLL_SPEED_PX
} from "../../src/client/dragAutoScroll.js";

function containerRect(overrides = {}) {
  return { top: 0, bottom: 400, height: 400, ...overrides };
}

function fakeClock() {
  const pending = [];
  return {
    requestFrame: (cb) => pending.push(cb),
    cancelFrame: (id) => {
      pending[id - 1] = null;
    },
    fire() {
      const cb = pending.shift();
      if (cb) cb();
    },
    pendingCount() {
      return pending.filter(Boolean).length;
    }
  };
}

function fakeContainer(overrides = {}) {
  return {
    getBoundingClientRect: () => containerRect(overrides.rect),
    scrollBy: vi.fn(),
    scrollTop: overrides.scrollTop ?? 100,
    scrollHeight: overrides.scrollHeight ?? 1000,
    clientHeight: overrides.clientHeight ?? 400
  };
}

describe("hotZoneSize", () => {
  it("floors to MIN_HOT_ZONE_PX when the proportional band is small but the cap allows it", () => {
    // 300 * 0.15 = 45 (below the 64px floor); 300 / 3 = 100 (cap has room) -> floor wins
    expect(hotZoneSize(300)).toBe(64);
  });

  it("uses the proportional band once it exceeds the floor", () => {
    // 1000 * 0.15 = 150, well above the 64px floor and below the 333.3px cap
    expect(hotZoneSize(1000)).toBe(150);
  });

  it("never exceeds a third of the container height, even in a short column", () => {
    // 150 * 0.15 = 22.5 (below floor) but 150 / 3 = 50 -> the cap overrides the floor
    expect(hotZoneSize(150)).toBeCloseTo(50, 5);
    expect(hotZoneSize(150)).toBeLessThanOrEqual(150 / 3);
  });
});

describe("computeAutoScroll", () => {
  it("reports scroll up when the pointer is within the top band and scroll room remains", () => {
    const result = computeAutoScroll({
      containerRect: containerRect(),
      pointerY: 10,
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 400
    });
    expect(result.direction).toBe("up");
    expect(result.speed).toBeGreaterThanOrEqual(MIN_SCROLL_SPEED_PX);
    expect(result.speed).toBeLessThanOrEqual(MAX_SCROLL_SPEED_PX);
  });

  it("does not scroll up once the container is already at scrollTop 0", () => {
    const result = computeAutoScroll({
      containerRect: containerRect(),
      pointerY: 10,
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 400
    });
    expect(result.direction).toBeNull();
  });

  it("reports scroll down when the pointer is within the bottom band and scroll room remains", () => {
    const result = computeAutoScroll({
      containerRect: containerRect(),
      pointerY: 390,
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 400
    });
    expect(result.direction).toBe("down");
  });

  it("does not scroll down once the container has reached its scroll limit", () => {
    const result = computeAutoScroll({
      containerRect: containerRect(),
      pointerY: 390,
      scrollTop: 600,
      scrollHeight: 1000,
      clientHeight: 400
    });
    expect(result.direction).toBeNull();
  });

  it("reports no scroll when the pointer sits in the dead zone between the two bands", () => {
    const result = computeAutoScroll({
      containerRect: containerRect(),
      pointerY: 200,
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 400
    });
    expect(result.direction).toBeNull();
  });

  it("uses the dragged card's derived leading top edge, not just the pointer, for a tall card", () => {
    // Grab-point is mid-card (pointer sits well outside the top band) but the card's own
    // top edge -- derived from pointerY minus the grab offset captured at dragstart -- already
    // overlaps it. This is the tall-card failure mode the card describes.
    const result = computeAutoScroll({
      containerRect: containerRect(),
      pointerY: 200,
      cardOffset: { grabOffsetY: 198, height: 388 }, // top = 200 - 198 = 2
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 400
    });
    expect(result.direction).toBe("up");
  });

  it("uses the dragged card's derived leading bottom edge for a tall card approaching the bottom", () => {
    const result = computeAutoScroll({
      containerRect: containerRect(),
      pointerY: 200,
      cardOffset: { grabOffsetY: 190, height: 388 }, // top = 10, bottom = 10 + 388 = 398
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 400
    });
    expect(result.direction).toBe("down");
  });

  it("picks whichever edge is more deeply into its band when a card overlaps both zones", () => {
    // A card almost as tall as the column overlaps both bands at once; the deeper overlap
    // (bottom, here) should win rather than top always taking priority.
    const result = computeAutoScroll({
      containerRect: containerRect(),
      pointerY: 200,
      cardOffset: { grabOffsetY: 180, height: 399 }, // top = 20, bottom = 20 + 399 = 419
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 400
    });
    expect(result.direction).toBe("down");
  });

  it("derives the leading edge from pointer position each call, so it follows the pointer as it moves (not a stale static rect)", () => {
    // VALIDATION FAIL (run 1): the old implementation read draggedElement.getBoundingClientRect()
    // -- the source card's rect, which never moves during an HTML5 drag (the drag image is a
    // detached snapshot with no queryable rect; the source element stays in normal flow). This
    // replays the reviewer's exact counterexample: containerRect {top:0,bottom:400,height:400}
    // (band=64), pointerY=395 (deep in the bottom band), with a card offset that keeps the
    // derived card rect following the pointer (grabOffsetY: 95, height: 100, so top = 300,
    // bottom = 400). With the old stale-rect bug (card frozen at {top:0,bottom:100}), this
    // scenario incorrectly won "up". The pointer-derived edge must win "down" instead.
    const result = computeAutoScroll({
      containerRect: containerRect(),
      pointerY: 395,
      cardOffset: { grabOffsetY: 95, height: 100 },
      scrollTop: 400,
      scrollHeight: 1000,
      clientHeight: 400
    });
    expect(result.direction).toBe("down");
  });

  it("falls back to pointer-only when no cardOffset is given (drag started on a non-card element, or offset unavailable)", () => {
    const result = computeAutoScroll({
      containerRect: containerRect(),
      pointerY: 200,
      cardOffset: null,
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 400
    });
    expect(result.direction).toBeNull();
  });

  it("ramps speed up the deeper the pointer sits inside the band", () => {
    const shallow = computeAutoScroll({
      containerRect: containerRect(),
      pointerY: 63, // just inside the 64px band
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 400
    });
    const deep = computeAutoScroll({
      containerRect: containerRect(),
      pointerY: 0, // right at the edge -- maximum depth
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 400
    });
    expect(deep.speed).toBeGreaterThan(shallow.speed);
    expect(deep.speed).toBe(MAX_SCROLL_SPEED_PX);
  });

  it("treats the band boundary as exclusive so the two bands can never both fire at once", () => {
    const atBandEdge = computeAutoScroll({
      containerRect: containerRect(),
      pointerY: 64, // exactly hotZoneSize(400) away from the top -- outside the band
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 400
    });
    expect(atBandEdge.direction).toBeNull();
  });
});

describe("createAutoScrollController", () => {
  it("schedules a frame on attach", () => {
    const clock = fakeClock();
    const controller = createAutoScrollController({
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame
    });
    const container = fakeContainer();

    controller.attach(container);
    expect(clock.pendingCount()).toBe(1);
  });

  // VALIDATION FAIL (run 3, T-0288): the old tick() unconditionally called
  // `frameId = requestFrame(tick)` at the end of every tick, regardless of whether that tick
  // found anything to scroll -- a busy rAF loop running `getBoundingClientRect()` and the full
  // computation every frame for the rest of the drag once the container hit a scroll limit or
  // the pointer sat in the dead zone, exactly the "no busy rAF loop spinning against
  // scrollTop === 0 or scrollHeight - clientHeight" edge case the card calls out by name.
  it("idles instead of re-requesting a frame once a tick finds nothing to scroll (no pointer yet)", () => {
    const clock = fakeClock();
    const controller = createAutoScrollController({
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame
    });
    const container = fakeContainer();

    controller.attach(container);
    expect(clock.pendingCount()).toBe(1);

    clock.fire();
    // no update() was ever called -- there is nothing to check, so the loop must not keep
    // re-scheduling itself forever.
    expect(clock.pendingCount()).toBe(0);
  });

  it("idles instead of busy-looping once the container has reached its scroll limit", () => {
    const clock = fakeClock();
    const controller = createAutoScrollController({
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame
    });
    // Already at the top of its scroll range -- in-band pointer, but nowhere left to scroll.
    const container = fakeContainer({ scrollTop: 0 });

    controller.attach(container);
    controller.update(10, null);
    clock.fire();

    expect(container.scrollBy).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  it("resumes the loop when update() reports a new position after the loop went idle", () => {
    const clock = fakeClock();
    const controller = createAutoScrollController({
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame
    });
    const container = fakeContainer({ scrollTop: 100 });

    controller.attach(container);
    controller.update(200, null); // dead zone -- no scroll
    clock.fire();
    expect(clock.pendingCount()).toBe(0);

    controller.update(10, null); // now in the top band
    expect(clock.pendingCount()).toBe(1);

    clock.fire();
    expect(container.scrollBy).toHaveBeenCalledTimes(1);
  });

  it("keeps the loop alive on its own while the pointer stays in-band and scrollable", () => {
    const clock = fakeClock();
    const controller = createAutoScrollController({
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame
    });
    const container = fakeContainer({ scrollTop: 100 });

    controller.attach(container);
    controller.update(10, null);
    clock.fire();

    expect(container.scrollBy).toHaveBeenCalledTimes(1);
    // still scrollable and still in-band -- the tick reschedules itself without needing
    // another update() call.
    expect(clock.pendingCount()).toBe(1);
  });

  it("does not start a second loop when already attached", () => {
    const clock = fakeClock();
    const controller = createAutoScrollController({
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame
    });
    const container = fakeContainer();

    controller.attach(container);
    controller.attach(container);
    expect(clock.pendingCount()).toBe(1);
  });

  it("scrolls the container on a tick when the last known pointer position is in-band", () => {
    const clock = fakeClock();
    const controller = createAutoScrollController({
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame
    });
    const container = fakeContainer({ scrollTop: 100 });

    controller.attach(container);
    controller.update(10, null);
    clock.fire();

    expect(container.scrollBy).toHaveBeenCalledTimes(1);
    const [, delta] = container.scrollBy.mock.calls[0];
    expect(delta).toBeLessThan(0); // scrolling up is a negative delta
  });

  it("does not scroll on a tick when the pointer is outside the band", () => {
    const clock = fakeClock();
    const controller = createAutoScrollController({
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame
    });
    const container = fakeContainer({ scrollTop: 100 });

    controller.attach(container);
    controller.update(200, null);
    clock.fire();

    expect(container.scrollBy).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  it("stops scrolling and cancels the pending frame on detach", () => {
    const clock = fakeClock();
    const controller = createAutoScrollController({
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame
    });
    const container = fakeContainer({ scrollTop: 100 });

    controller.attach(container);
    controller.update(10, null);
    controller.detach();

    expect(clock.pendingCount()).toBe(0);
    expect(controller.isAttached()).toBe(false);

    // even if a stray frame still fires, the detached loop must not touch the container
    clock.fire();
    expect(container.scrollBy).not.toHaveBeenCalled();
  });

  it("re-attaching after detach starts a fresh loop", () => {
    const clock = fakeClock();
    const controller = createAutoScrollController({
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame
    });
    const container = fakeContainer();

    controller.attach(container);
    controller.detach();
    controller.attach(container);

    expect(clock.pendingCount()).toBe(1);
  });
});
