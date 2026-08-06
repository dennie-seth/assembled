// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { initGoUpButton } from "../../src/client/goUp.js";

function makeScrollSource(initialY = 0) {
  const src = {
    scrollY: initialY,
    _listeners: {},
    addEventListener(type, fn) {
      this._listeners[type] = fn;
    },
    dispatchScroll(y) {
      this.scrollY = y;
      this._listeners["scroll"]?.();
    }
  };
  return src;
}

describe("initGoUpButton", () => {
  let btn;
  let scrollSource;
  let scrollTarget;

  beforeEach(() => {
    btn = document.createElement("button");
    scrollTarget = { scrollTo: vi.fn() };
    scrollSource = makeScrollSource(0);
  });

  it("hides the button initially", () => {
    initGoUpButton(btn, { scrollSource, scrollTarget });
    expect(btn.hidden).toBe(true);
  });

  it("shows the button when scrollY meets threshold", () => {
    initGoUpButton(btn, { scrollSource, scrollTarget, threshold: 200 });
    scrollSource.dispatchScroll(200);
    expect(btn.hidden).toBe(false);
  });

  it("shows the button when scrollY exceeds threshold", () => {
    initGoUpButton(btn, { scrollSource, scrollTarget, threshold: 200 });
    scrollSource.dispatchScroll(500);
    expect(btn.hidden).toBe(false);
  });

  it("keeps button hidden below threshold", () => {
    initGoUpButton(btn, { scrollSource, scrollTarget, threshold: 200 });
    scrollSource.dispatchScroll(199);
    expect(btn.hidden).toBe(true);
  });

  it("hides again when scrollY drops back below threshold", () => {
    initGoUpButton(btn, { scrollSource, scrollTarget, threshold: 200 });
    scrollSource.dispatchScroll(300);
    expect(btn.hidden).toBe(false);
    scrollSource.dispatchScroll(100);
    expect(btn.hidden).toBe(true);
  });

  it("calls scrollTarget.scrollTo with top:0 on click", () => {
    initGoUpButton(btn, { scrollSource, scrollTarget });
    btn.click();
    expect(scrollTarget.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("uses threshold 200 by default", () => {
    initGoUpButton(btn, { scrollSource, scrollTarget });
    scrollSource.dispatchScroll(199);
    expect(btn.hidden).toBe(true);
    scrollSource.dispatchScroll(200);
    expect(btn.hidden).toBe(false);
  });
});
