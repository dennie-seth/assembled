// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp } from "../../src/client/app.js";

// T-0462: Alt+ArrowDown/Alt+ArrowUp step between a card's sections, Alt+C/Alt+A jump straight to
// the composer/attachments. These live in app.js (not detailPanel.js) because the key listener
// needs selectedId and the detailRoot the app already owns -- see detailPanel.sectionNav.test.js
// for the section-discovery/focus-movement logic itself, which these tests exercise through the
// app's real document-level keydown wiring rather than re-testing directly.
//
// Collision check performed before binding anything (see CLAUDE.md conduct + this card's
// acceptance criteria): a repo-wide search turned up no pre-existing keydown/ArrowUp/ArrowDown
// listener anywhere under tools/board/src/client -- nothing to collide with. Alt+Arrow/Alt+Letter
// is chosen specifically because: bare ArrowUp/ArrowDown are relied on for native page/select
// scrolling (and for moving the current option in the detail panel's own <select> fields --
// priority/status/agent/phase/complexity/the jump select itself), and a bare letter would eat a
// keystroke the instant it fired while typing anywhere. Alt+Left/Right (browser back/forward) and
// Alt+D (address bar, in Chrome) were deliberately avoided for the same reason.

function manyComments(count) {
  return Array.from({ length: count }, (_, i) => ({
    author: "Dennie",
    text: `Comment number ${i + 1}`,
    timestamp: `2026-08-05T${String(10 + i).padStart(2, "0")}:00:00.000Z`
  }));
}

function task(overrides = {}) {
  return {
    id: "T-0001",
    title: "Sample",
    status: "backlog",
    priority: "P2",
    phase: 1,
    agent: null,
    depends_on: [],
    created: "2026-07-31",
    body: "## Context\nsome context\n\n## Acceptance\n- [ ] do it",
    comments: [],
    ...overrides
  };
}

let boardRoot, detailRoot, consoleRoot, createFormRoot, sidePanelRoot;

function makeApp(overrides = {}) {
  boardRoot = document.createElement("div");
  detailRoot = document.createElement("div");
  consoleRoot = document.createElement("div");
  createFormRoot = document.createElement("div");
  sidePanelRoot = document.createElement("div");
  document.body.append(boardRoot, detailRoot, consoleRoot, createFormRoot, sidePanelRoot);

  const app = createApp({
    boardRoot,
    detailRoot,
    consoleRoot,
    createFormRoot,
    sidePanelRoot,
    gitStatusRoot: null,
    fetchTasksImpl: overrides.fetchTasksImpl ?? vi.fn().mockResolvedValue([]),
    fetchAgentsImpl: vi.fn().mockResolvedValue([]),
    patchTaskImpl: vi.fn(),
    connectSocketImpl: vi.fn(),
    runTaskImpl: vi.fn(),
    cancelTaskImpl: vi.fn(),
    createTaskImpl: vi.fn(),
    deleteTaskImpl: vi.fn(),
    exportBacklogImpl: vi.fn(),
    exportDoneImpl: vi.fn(),
    fetchGitStatusImpl: null,
    addCommentImpl: vi.fn(),
    uploadAttachmentImpl: vi.fn(),
    removeAttachmentImpl: vi.fn(),
    fetchPollerStatusImpl: null
  });
  return app;
}

function altKeydown(target, key) {
  const event = new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function plainKeydown(target, key) {
  const event = new KeyboardEvent("keydown", { key, altKey: false, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

// FIX ROUND 2: a real keydown's `event.target` is whatever element currently has focus
// (`document.activeElement`), NOT the element the previous test happened to dispatch on. Firing
// every event on `document.body` regardless of where focus actually moved masked the exact bug
// this round fixes -- see detailPanel.js's FIX ROUND 2 comments for the dead-end it caused. This
// helper dispatches on the real current focus target, the way a browser actually does.
function altKeydownOnActive(key) {
  return altKeydown(document.activeElement ?? document.body, key);
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("detail panel section-navigation keyboard shortcuts", () => {
  let app;

  beforeEach(async () => {
    app = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([task({ id: "T-0001", comments: manyComments(13) })])
    });
    await app.init();
    app.handleCardClick("T-0001");
  });

  it("Alt+ArrowDown moves focus to the first section when nothing is focused yet", () => {
    altKeydown(document.body, "ArrowDown");
    expect(document.activeElement).toBe(detailRoot.querySelector(".detail-top-landmark"));
  });

  // FIX ROUND 2: this is the test that catches the real bug. Each keydown now fires on
  // `document.activeElement` -- wherever the *previous* step actually left focus -- exactly like
  // a browser does, instead of always on `document.body` (which bypassed shouldIgnoreDetailNavKey
  // entirely and hid the dead-end: landing on "top", a real <input>, made every following
  // Alt+ArrowDown a no-op because real text-entry focus correctly suppresses the shortcut).
  // FIX ROUND 3: order is derived from actual DOM position (detailPanel.js), not an assumed
  // "top, body, acceptance, comments, composer, attachments" sequence -- the panel's real
  // append order puts comments/composer/attachments BEFORE the body preview.
  it("Alt+ArrowDown repeatedly walks every named section in order, even through the top and composer landmarks", () => {
    const seenClasses = [];
    for (let i = 0; i < 6; i++) {
      altKeydownOnActive("ArrowDown");
      seenClasses.push(document.activeElement.className || document.activeElement.tagName);
    }
    expect(seenClasses[0]).toContain("detail-top-landmark");
    expect(seenClasses[1]).toContain("detail-comment");
    expect(seenClasses[2]).toContain("detail-composer-landmark");
    expect(seenClasses[3]).toContain("detail-attachments");
    expect(seenClasses[4]).toContain("detail-body-preview");
    expect(seenClasses[5]).toMatch(/^H[1-6]$/);
  });

  it("Alt+ArrowUp moves backward", () => {
    altKeydownOnActive("ArrowDown");
    altKeydownOnActive("ArrowDown");
    altKeydownOnActive("ArrowUp");
    expect(document.activeElement).toBe(detailRoot.querySelector(".detail-top-landmark"));
  });

  it("Alt+C jumps straight to the composer regardless of current position", () => {
    altKeydownOnActive("ArrowDown"); // sits on "top" (a non-text-entry landmark, not a dead end)
    altKeydownOnActive("c");
    expect(document.activeElement).toBe(detailRoot.querySelector(".detail-composer-landmark"));
  });

  it("Alt+A jumps straight to attachments regardless of current position", () => {
    altKeydownOnActive("ArrowDown"); // sits on "top"
    altKeydownOnActive("a");
    expect(document.activeElement.closest(".detail-attachments")).not.toBeNull();
  });

  it("Alt+ArrowDown past the composer landmark reaches attachments next -- composer does not swallow further steps", () => {
    for (let i = 0; i < 3; i++) altKeydownOnActive("ArrowDown"); // top, comments, composer
    expect(document.activeElement).toBe(detailRoot.querySelector(".detail-composer-landmark"));
    altKeydownOnActive("ArrowDown");
    expect(document.activeElement.closest(".detail-attachments")).not.toBeNull();
  });

  it("Tab out of the top landmark reaches the real title input one step away, unchanged", () => {
    altKeydownOnActive("ArrowDown"); // sits on the "top" landmark
    const landmark = document.activeElement;
    expect(landmark.className).toContain("detail-top-landmark");
    expect(landmark.querySelector(".detail-title")).toBe(detailRoot.querySelector(".detail-title"));
  });

  it("a bare ArrowDown (no Alt) does not navigate -- native scrolling/select behaviour is left alone", () => {
    plainKeydown(document.body, "ArrowDown");
    expect(document.activeElement).not.toBe(detailRoot.querySelector(".detail-title"));
  });

  it("does nothing when no card is selected", () => {
    app.handleClose();
    expect(() => altKeydown(document.body, "ArrowDown")).not.toThrow();
  });
});

describe("detail panel section-navigation shortcuts never fire while the user is typing", () => {
  let app;

  beforeEach(async () => {
    app = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([task({ id: "T-0001", comments: manyComments(13) })])
    });
    await app.init();
    app.handleCardClick("T-0001");
  });

  it("Alt+ArrowDown with focus in the compose box inserts nothing and does not navigate away -- it leaves the keystroke to the textarea", () => {
    const input = detailRoot.querySelector(".detail-comment-input");
    input.focus();
    input.value = "typing a reply";

    const event = altKeydown(input, "ArrowDown");

    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("typing a reply");
    expect(event.defaultPrevented).toBe(false);
  });

  it("Alt+C with focus in the compose box does not steal focus or get intercepted -- 'c' must still be typeable", () => {
    const input = detailRoot.querySelector(".detail-comment-input");
    input.focus();

    const event = altKeydown(input, "c");

    expect(document.activeElement).toBe(input);
    expect(event.defaultPrevented).toBe(false);
  });

  it("Alt+ArrowDown with focus in the title input does not navigate away", () => {
    const title = detailRoot.querySelector(".detail-title");
    title.focus();
    title.value = "Renaming in progr";

    altKeydown(title, "ArrowDown");

    expect(document.activeElement).toBe(title);
    expect(title.value).toBe("Renaming in progr");
  });

  it("Alt+ArrowDown with focus on a <select> field does not navigate -- the native open-dropdown gesture is left alone", () => {
    const prioritySelect = detailRoot.querySelector(".detail-priority");
    prioritySelect.focus();

    const event = altKeydown(prioritySelect, "ArrowDown");

    expect(document.activeElement).toBe(prioritySelect);
    expect(event.defaultPrevented).toBe(false);
  });

  it("Alt+ArrowDown with focus in the body markdown textarea does not navigate away", () => {
    const body = detailRoot.querySelector(".detail-body-edit");
    body.focus();
    body.value = "## Context\nediting this in place";

    altKeydown(body, "ArrowDown");

    expect(document.activeElement).toBe(body);
    expect(body.value).toBe("## Context\nediting this in place");
  });
});

describe("switching cards mid-navigation resets the section position", () => {
  it("navigating card A then selecting card B starts B's navigation fresh", async () => {
    const app = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([
        task({ id: "T-0001", title: "Card A", comments: manyComments(13) }),
        task({ id: "T-0002", title: "Card B", comments: [] })
      ])
    });
    await app.init();

    app.handleCardClick("T-0001");
    altKeydownOnActive("ArrowDown");
    altKeydownOnActive("ArrowDown");
    altKeydownOnActive("ArrowDown"); // somewhere mid-card-A

    app.handleCardClick("T-0002");
    altKeydownOnActive("ArrowDown");

    expect(document.activeElement).toBe(detailRoot.querySelector(".detail-top-landmark"));
    expect(detailRoot.dataset.taskId).toBe("T-0002");
  });
});
