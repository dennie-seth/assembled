// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

// #terminal-panel is a separate fixed element pinned to the viewport bottom.
// These tests load the real style.css into happy-dom's CSSOM and assert on
// getComputedStyle, because the underlying bug is that #side-panel's fixed
// box didn't leave room for it and got painted over - a cascade/layout
// issue the client unit tests (which don't apply CSS) can't see.

beforeAll(() => {
  const css = fs.readFileSync(path.join(process.cwd(), "src/client/style.css"), "utf8");
  const styleEl = document.createElement("style");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);
});

describe("side panel / terminal panel layout", () => {
  it("reserves space above the terminal panel instead of extending under it", () => {
    const terminalPanel = document.createElement("div");
    terminalPanel.id = "terminal-panel";
    const sidePanel = document.createElement("div");
    sidePanel.id = "side-panel";
    document.body.append(terminalPanel, sidePanel);

    const terminalHeight = getComputedStyle(terminalPanel).height;
    expect(getComputedStyle(sidePanel).bottom).not.toBe("0px");
    expect(getComputedStyle(sidePanel).bottom).toBe(terminalHeight);
  });

  it("shrinks the reserved space to match a collapsed terminal panel", () => {
    const terminalPanel = document.createElement("div");
    terminalPanel.id = "terminal-panel";
    terminalPanel.className = "collapsed";
    const sidePanel = document.createElement("div");
    sidePanel.id = "side-panel";
    document.body.append(terminalPanel, sidePanel);

    const terminalHeight = getComputedStyle(terminalPanel).height;
    expect(getComputedStyle(sidePanel).bottom).toBe(terminalHeight);
  });

  it("keeps the detail pane independently scrollable so it can never be trapped behind the console/terminal", () => {
    const detail = document.createElement("div");
    detail.id = "detail";
    document.body.appendChild(detail);

    const cs = getComputedStyle(detail);
    expect(cs.overflowY).toBe("auto");
    expect(cs.minHeight).toBe("0");
  });
});
