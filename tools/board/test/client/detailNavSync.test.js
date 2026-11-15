// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderDetailPanel, listDetailSections, focusDetailSection } from "../../src/client/detailPanel.js";
import { captureViewState, applyViewState } from "../../src/client/viewState.js";

// T-0462 FIX ROUND (2026-11-15, Codex review): round 1 fixed the focus itself returning to the
// restored section on a same-card re-render (a comment arriving over the socket), but the nav
// bar's own label, jump selector and Prev/Next boundary buttons never got told -- they were
// computed earlier, in `populateNavBar` (run synchronously inside `renderDetailPanel`, before
// `applyViewState` has restored focus), so they always described the stale pre-restore position.
// These tests drive the exact same sequence `app.js`'s `render()` does -- capture, rebuild,
// restore -- through the real `renderDetailPanel` output, not by calling the nav-sync helper
// directly, so a regression in call ordering would be caught here the same way it was found.

function manyComments(count) {
  return Array.from({ length: count }, (_, i) => ({
    author: "Dennie",
    text: `Comment number ${i + 1} with some measurement detail that runs long.`,
    timestamp: `2026-08-05T${String(10 + i).padStart(2, "0")}:00:00.000Z`
  }));
}

function task(overrides = {}) {
  return {
    id: "T-0001",
    title: "Sample task",
    status: "backlog",
    priority: "P2",
    phase: 1,
    agent: "infra",
    depends_on: [],
    created: "2026-07-31",
    body: "## Context\nsome context\n\n## Acceptance\n- [ ] do it",
    max_attempts: null,
    complexity_points: null,
    ...overrides
  };
}

function baseOpts(overrides = {}) {
  return {
    onSave: vi.fn(),
    onClose: vi.fn(),
    onDelete: vi.fn(),
    onAddComment: vi.fn(),
    onUploadAttachment: vi.fn(),
    agentOptions: ["infra"],
    allTasks: [{ id: "T-0001", title: "Sample task" }],
    ...overrides
  };
}

// Simulates one tick of app.js's render(): capture, rebuild (socket-style update to the SAME
// card), restore.
function rerenderSameCard(root, nextTask, opts) {
  const snapshot = captureViewState(root);
  renderDetailPanel(root, nextTask, opts);
  applyViewState(root, snapshot);
}

function navBarParts(root) {
  return {
    current: root.querySelector(".detail-nav-current"),
    jump: root.querySelector(".detail-nav-jump"),
    prev: root.querySelector(".detail-nav-prev"),
    next: root.querySelector(".detail-nav-next")
  };
}

describe("nav bar re-synchronises after section focus is restored on a same-card rebuild", () => {
  let root;
  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
  });
  afterEach(() => {
    document.body.removeChild(root);
  });

  it("names the restored section, matches the jump selector, and sets both boundary buttons from the same resolved index", () => {
    const withAttachments = (overrides = {}) =>
      task({
        comments: manyComments(13),
        attachments: [{ filename: "render.png", size: 1, mimetype: "image/png" }],
        ...overrides
      });

    renderDetailPanel(root, withAttachments(), baseOpts());
    // Real document order for this card is top, comments, composer, attachments, body,
    // acceptance (FIX ROUND 3) -- "body" is neither the first nor the last section.
    expect(listDetailSections(root).map((s) => s.key)).toEqual([
      "top",
      "comments",
      "composer",
      "attachments",
      "body",
      "acceptance"
    ]);
    focusDetailSection(root, "body");

    // A new comment lands over the socket -- same card, re-rendered.
    rerenderSameCard(root, withAttachments({ comments: manyComments(14) }), baseOpts());

    expect(document.activeElement.dataset.detailSection).toBe("body");
    const { current, jump, prev, next } = navBarParts(root);
    expect(current.textContent).toBe("Section: Body");
    expect(jump.value).toBe("body");
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(false);
  });

  it("does not scroll while re-synchronising -- restoring focus must never move the panel", () => {
    renderDetailPanel(root, task({ comments: manyComments(13) }), baseOpts());
    focusDetailSection(root, "composer");

    const scrollSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    scrollSpy.mockClear();

    const snapshot = captureViewState(root);
    renderDetailPanel(root, task({ comments: manyComments(14) }), baseOpts());
    root.scrollTop = 321; // wherever the rebuild happened to leave it
    scrollSpy.mockClear(); // isolate the restore call below from anything render-time did

    applyViewState(root, snapshot);

    expect(scrollSpy).not.toHaveBeenCalled();
    expect(root.scrollTop).toBe(321);
    scrollSpy.mockRestore();
  });

  it("the Top case: restoring to the first section shows Top consistently, and picking a different section still fires a change", () => {
    renderDetailPanel(root, task({ comments: manyComments(13) }), baseOpts());
    focusDetailSection(root, "top");

    rerenderSameCard(root, task({ comments: manyComments(14) }), baseOpts());

    const { current, jump, prev, next } = navBarParts(root);
    expect(current.textContent).toBe("Section: Top");
    expect(jump.value).toBe("top");
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);

    jump.value = "attachments";
    jump.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.activeElement.closest(".detail-attachments")).not.toBeNull();
  });

  it("leaves the bar in a coherent state when the restored section is absent from the rebuilt card", () => {
    renderDetailPanel(
      root,
      task({ comments: manyComments(13), attachments: [{ filename: "a.png", size: 1, mimetype: "image/png" }] }),
      baseOpts()
    );
    focusDetailSection(root, "attachments");

    // Same card, but this update has no attachments any more.
    rerenderSameCard(
      root,
      task({ comments: manyComments(13) }),
      baseOpts({ onUploadAttachment: undefined })
    );

    const { current, jump } = navBarParts(root);
    expect(current.textContent).not.toBe("Section: Attachments");
    expect(jump.value).not.toBe("attachments");
    expect(Array.from(root.querySelectorAll(".detail-nav-jump option")).map((o) => o.value)).not.toContain(
      "attachments"
    );
  });

  it("a genuine card switch still resets rather than restores, and the bar reflects the new card", () => {
    renderDetailPanel(root, task({ id: "T-0001", comments: manyComments(13) }), baseOpts());
    focusDetailSection(root, "composer");
    const snapshot = captureViewState(root);

    renderDetailPanel(
      root,
      task({ id: "T-0002", comments: [], body: "## Context\nshort" }),
      baseOpts({ onUploadAttachment: undefined, allTasks: [{ id: "T-0002", title: "Other task" }] })
    );
    applyViewState(root, snapshot);

    // Round 1's guard: nothing is auto-focused onto the new card -- the old card's section
    // (keyed "composer") must not be re-attached to T-0002's structurally identical landmark.
    expect(document.activeElement).toBe(document.body);
    const { jump } = navBarParts(root);
    // T-0002 has no attachments and an empty comment thread (but a composer is still offered),
    // so its jump list is its own, not T-0001's stale options.
    expect(Array.from(root.querySelectorAll(".detail-nav-jump option")).map((o) => o.value)).toEqual([
      "top",
      "composer",
      "body"
    ]);
  });

  it("a detail panel with no task selected has no nav bar to desync -- nothing to disable or scroll", () => {
    renderDetailPanel(root, task({ comments: manyComments(13) }), baseOpts());
    focusDetailSection(root, "composer");

    const snapshot = captureViewState(root);
    renderDetailPanel(root, null, baseOpts());

    expect(() => applyViewState(root, snapshot)).not.toThrow();
    expect(root.querySelector(".detail-nav")).toBeNull();
  });
});
