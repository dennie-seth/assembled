// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  renderDetailPanel,
  listDetailSections,
  stepDetailSection,
  focusDetailSection
} from "../../src/client/detailPanel.js";

// T-0462: the compose box and attachments on a long card (T-0436 has 13 comments, several
// multi-screen) were only reachable by scrolling the whole comment thread. These tests cover the
// section-navigation mechanism added to reach them directly: a fixed set of named landmarks
// (top, body, acceptance, latest comment, composer, attachments) that a user can step through in
// either direction or jump to directly, without scrolling past anything in between.

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

function attached() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

describe("listDetailSections", () => {
  let root;
  beforeEach(() => {
    root = attached();
  });
  afterEach(() => {
    document.body.removeChild(root);
  });

  it("lists top, latest comment, composer, attachments, body and acceptance in actual DOM reading order for a full card", () => {
    // FIX ROUND 3: the panel's real append order (renderDetailPanel) is top, then the
    // comments section (with the composer inside it), then attachments, and only THEN the
    // body preview (with the Acceptance heading inside that). A hardcoded "top, body,
    // acceptance, comments, composer, attachments" list does not match that -- it made a
    // down-labelled Next button scroll UP (to the body, below everything) and disabled Next at
    // "attachments" even though body/acceptance still sit below it in the real page. Order is
    // now derived from each element's actual document position, not an assumed sequence.
    renderDetailPanel(root, task({ comments: manyComments(13), attachments: [] }), baseOpts());
    const keys = listDetailSections(root).map((s) => s.key);
    expect(keys).toEqual(["top", "comments", "composer", "attachments", "body", "acceptance"]);
  });

  it("names each section with a human-readable label", () => {
    renderDetailPanel(root, task({ comments: manyComments(2) }), baseOpts());
    const labels = Object.fromEntries(listDetailSections(root).map((s) => [s.key, s.label]));
    expect(labels).toEqual({
      top: "Top",
      body: "Body",
      acceptance: "Acceptance",
      comments: "Latest comment",
      composer: "Composer",
      attachments: "Attachments"
    });
  });

  it("omits the latest-comment section when the card has no comments", () => {
    renderDetailPanel(root, task({ comments: [] }), baseOpts());
    const keys = listDetailSections(root).map((s) => s.key);
    expect(keys).not.toContain("comments");
    expect(keys).toContain("composer");
  });

  it("omits composer and latest-comment when onAddComment is not provided", () => {
    renderDetailPanel(root, task({ comments: manyComments(3) }), baseOpts({ onAddComment: undefined }));
    const keys = listDetailSections(root).map((s) => s.key);
    expect(keys).not.toContain("composer");
    expect(keys).not.toContain("comments");
  });

  it("omits attachments when onUploadAttachment is not provided", () => {
    renderDetailPanel(root, task(), baseOpts({ onUploadAttachment: undefined }));
    expect(listDetailSections(root).map((s) => s.key)).not.toContain("attachments");
  });

  it("omits acceptance when the body has no Acceptance heading -- navigation must not assume comments or a fixed template dominate the page", () => {
    renderDetailPanel(root, task({ body: "Just a long paragraph of prose with no headings at all." }), baseOpts());
    expect(listDetailSections(root).map((s) => s.key)).not.toContain("acceptance");
  });

  it("still navigates sanely with neither comments nor attachments -- only top/body/acceptance remain", () => {
    renderDetailPanel(
      root,
      task({ comments: [] }),
      baseOpts({ onAddComment: undefined, onUploadAttachment: undefined })
    );
    expect(listDetailSections(root).map((s) => s.key)).toEqual(["top", "body", "acceptance"]);
  });

  it("the latest-comment target tracks whichever comment is actually last, even after more arrive", () => {
    renderDetailPanel(root, task({ comments: manyComments(2) }), baseOpts());
    let sections = listDetailSections(root);
    let latest = sections.find((s) => s.key === "comments").element;
    expect(latest.textContent).toContain("Comment number 2");

    // Simulate a comment arriving over the live socket while the panel is open.
    renderDetailPanel(root, task({ comments: manyComments(3) }), baseOpts());
    sections = listDetailSections(root);
    latest = sections.find((s) => s.key === "comments").element;
    expect(latest.textContent).toContain("Comment number 3");
  });
});

describe("accessibility: section landmarks are focusable and have accessible names", () => {
  let root;
  beforeEach(() => {
    root = attached();
  });
  afterEach(() => {
    document.body.removeChild(root);
  });

  it("the body and attachments landmarks are focusable regions with an aria-label", () => {
    renderDetailPanel(root, task({ comments: manyComments(2) }), baseOpts());
    const sections = Object.fromEntries(listDetailSections(root).map((s) => [s.key, s.element]));

    expect(sections.body.tabIndex).toBe(-1);
    expect(sections.body.getAttribute("role")).toBe("region");
    expect(sections.body.getAttribute("aria-label")).toBe("Body");

    expect(sections.attachments.tabIndex).toBe(-1);
    expect(sections.attachments.getAttribute("role")).toBe("region");
    expect(sections.attachments.getAttribute("aria-label")).toBe("Attachments");
  });

  it("the acceptance heading is focusable (headings are already a landmark with their own text as accessible name)", () => {
    renderDetailPanel(root, task(), baseOpts());
    const acceptance = listDetailSections(root).find((s) => s.key === "acceptance").element;
    expect(acceptance.tagName).toMatch(/^H[1-6]$/);
    expect(acceptance.tabIndex).toBe(-1);
  });

  it("the latest comment is focusable and labeled so a screen reader announces which comment it is", () => {
    renderDetailPanel(root, task({ comments: manyComments(2) }), baseOpts());
    const latest = listDetailSections(root).find((s) => s.key === "comments").element;
    expect(latest.tabIndex).toBe(-1);
    expect(latest.getAttribute("aria-label")).toMatch(/comment/i);
  });

  it("the composer target is a group landmark (not the textarea itself) with an explicit accessible name", () => {
    renderDetailPanel(root, task(), baseOpts());
    const composer = listDetailSections(root).find((s) => s.key === "composer").element;
    expect(composer.tabIndex).toBe(-1);
    expect(composer.getAttribute("role")).toBe("group");
    expect(composer.getAttribute("aria-label")).toBeTruthy();
    // The real textarea is still reachable/editable one Tab away -- just not the nav target.
    expect(composer.querySelector(".detail-comment-input")).not.toBeNull();
  });

  it("the top target is a group landmark wrapping the title field, with its own accessible name", () => {
    renderDetailPanel(root, task(), baseOpts());
    const top = listDetailSections(root).find((s) => s.key === "top").element;
    expect(top.tabIndex).toBe(-1);
    expect(top.getAttribute("role")).toBe("group");
    expect(top.getAttribute("aria-label")).toBeTruthy();
    expect(top.querySelector("label")?.textContent).toContain("Title");
  });
});

describe("stepDetailSection: bidirectional navigation", () => {
  let root;
  beforeEach(() => {
    root = attached();
  });
  afterEach(() => {
    document.body.removeChild(root);
  });

  it("moving forward from nothing focused lands on the first section (top)", () => {
    renderDetailPanel(root, task({ comments: manyComments(13) }), baseOpts());
    const key = stepDetailSection(root, 1);
    expect(key).toBe("top");
    expect(document.activeElement).toBe(root.querySelector(".detail-top-landmark"));
  });

  it("repeated forward steps walk every section in actual DOM order", () => {
    renderDetailPanel(root, task({ comments: manyComments(13) }), baseOpts());
    const seen = [];
    for (let i = 0; i < 6; i++) {
      seen.push(stepDetailSection(root, 1));
    }
    expect(seen).toEqual(["top", "comments", "composer", "attachments", "body", "acceptance"]);
  });

  it("stepping backward from the last section walks back in reverse order", () => {
    renderDetailPanel(root, task({ comments: manyComments(13) }), baseOpts());
    for (let i = 0; i < 6; i++) stepDetailSection(root, 1); // drive to the last section (acceptance)
    const seen = [];
    for (let i = 0; i < 6; i++) seen.push(stepDetailSection(root, -1));
    expect(seen).toEqual(["body", "attachments", "composer", "comments", "top", "top"]);
  });

  it("repeating the forward key at the last section stops there -- it does not wrap to the top", () => {
    renderDetailPanel(root, task({ comments: manyComments(13) }), baseOpts());
    for (let i = 0; i < 6; i++) stepDetailSection(root, 1);
    expect(document.activeElement.tagName).toMatch(/^H[1-6]$/); // last section is "acceptance"
    const key = stepDetailSection(root, 1);
    expect(key).toBe("acceptance");
    expect(document.activeElement.tagName).toMatch(/^H[1-6]$/);
  });

  it("repeating the backward key at the first section stops there -- it does not wrap to the end", () => {
    renderDetailPanel(root, task({ comments: manyComments(13) }), baseOpts());
    stepDetailSection(root, 1); // top
    const key = stepDetailSection(root, -1);
    expect(key).toBe("top");
    expect(document.activeElement).toBe(root.querySelector(".detail-top-landmark"));
  });

  it("returns null and does nothing when there are no sections at all", () => {
    renderDetailPanel(root, null, baseOpts());
    expect(stepDetailSection(root, 1)).toBeNull();
  });
});

describe("focusDetailSection: direct jump -- reaching composer/attachments without traversing the thread", () => {
  let root;
  beforeEach(() => {
    root = attached();
  });
  afterEach(() => {
    document.body.removeChild(root);
  });

  it("jumps straight to the composer on a card with 13 comments, from a cold start (nothing focused)", () => {
    renderDetailPanel(root, task({ comments: manyComments(13) }), baseOpts());
    const ok = focusDetailSection(root, "composer");
    expect(ok).toBe(true);
    expect(document.activeElement).toBe(root.querySelector(".detail-composer-landmark"));
  });

  it("jumps straight to attachments on the same long card", () => {
    renderDetailPanel(
      root,
      task({ comments: manyComments(13), attachments: [{ filename: "a.png", size: 1, mimetype: "image/png" }] }),
      baseOpts()
    );
    const ok = focusDetailSection(root, "attachments");
    expect(ok).toBe(true);
    expect(document.activeElement.closest(".detail-attachments")).not.toBeNull();
  });

  it("jumps to attachments from the top in a single call -- no intermediate section is focused along the way", () => {
    renderDetailPanel(root, task({ comments: manyComments(13) }), baseOpts());
    stepDetailSection(root, 1); // sits on "top"
    focusDetailSection(root, "attachments");
    expect(document.activeElement.closest(".detail-attachments")).not.toBeNull();
  });

  it("returns false and does not move focus when the named section does not exist for this card", () => {
    renderDetailPanel(root, task({ comments: [] }), baseOpts({ onUploadAttachment: undefined }));
    const before = document.activeElement;
    const ok = focusDetailSection(root, "attachments");
    expect(ok).toBe(false);
    expect(document.activeElement).toBe(before);
  });
});

describe("switching cards mid-navigation resets position", () => {
  it("navigating a freshly selected, different task starts fresh rather than erroring on stale elements", () => {
    const root = attached();
    renderDetailPanel(root, task({ id: "T-0001", comments: manyComments(13) }), baseOpts());
    stepDetailSection(root, 1);
    stepDetailSection(root, 1);
    stepDetailSection(root, 1); // somewhere in the middle of T-0001

    renderDetailPanel(
      root,
      task({ id: "T-0002", comments: [], body: "## Context\nshort" }),
      baseOpts({ onUploadAttachment: undefined })
    );

    expect(() => stepDetailSection(root, 1)).not.toThrow();
    expect(document.activeElement).toBe(root.querySelector(".detail-top-landmark"));
    document.body.removeChild(root);
  });
});

describe("the nav bar UI (jump control)", () => {
  let root;
  beforeEach(() => {
    root = attached();
  });
  afterEach(() => {
    document.body.removeChild(root);
  });

  it("renders a jump select listing only the sections present for this card", () => {
    renderDetailPanel(
      root,
      task({ comments: [] }),
      baseOpts({ onAddComment: undefined, onUploadAttachment: undefined })
    );
    const options = Array.from(root.querySelectorAll(".detail-nav-jump option")).map((o) => o.value);
    expect(options).toEqual(["top", "body", "acceptance"]);
  });

  it("choosing an option in the jump select moves focus to that section", () => {
    renderDetailPanel(root, task({ comments: manyComments(5) }), baseOpts());
    const select = root.querySelector(".detail-nav-jump");
    select.value = "composer";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.activeElement).toBe(root.querySelector(".detail-composer-landmark"));
  });

  it("clicking Next/Prev steps through sections the same way the keyboard does", () => {
    renderDetailPanel(root, task({ comments: manyComments(5) }), baseOpts());
    root.querySelector(".detail-nav-next").dispatchEvent(new Event("click", { bubbles: true }));
    expect(document.activeElement).toBe(root.querySelector(".detail-top-landmark"));
    root.querySelector(".detail-nav-next").dispatchEvent(new Event("click", { bubbles: true }));
    expect(document.activeElement.className).toContain("detail-comment");
  });

  it("disables Next at the last section and Prev at the first, as a visible boundary signal", () => {
    renderDetailPanel(root, task({ comments: manyComments(5) }), baseOpts());
    const next = root.querySelector(".detail-nav-next");
    const prev = root.querySelector(".detail-nav-prev");

    stepDetailSection(root, 1); // top -- the first section
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);

    for (let i = 0; i < 5; i++) stepDetailSection(root, 1); // walk to the last section (acceptance)
    expect(document.activeElement.tagName).toMatch(/^H[1-6]$/);
    expect(next.disabled).toBe(true);
    expect(prev.disabled).toBe(false);
  });

  it("announces the current section via an aria-live region", () => {
    renderDetailPanel(root, task({ comments: manyComments(5) }), baseOpts());
    stepDetailSection(root, 1);
    const current = root.querySelector(".detail-nav-current");
    expect(current.getAttribute("aria-live")).toBe("polite");
    expect(current.textContent).toMatch(/top/i);
  });
});

describe("regression: existing detail-panel behaviour is unaffected by the nav bar", () => {
  it("an in-progress comment draft survives a re-render of the same task", () => {
    const root = attached();
    renderDetailPanel(root, task({ id: "T-0137", comments: manyComments(13) }), baseOpts());

    const input = root.querySelector(".detail-comment-input");
    input.focus();
    input.value = "please check the lo";

    renderDetailPanel(root, task({ id: "T-0137", comments: manyComments(13), attempts: 1 }), baseOpts());

    expect(root.querySelector(".detail-comment-input").value).toBe("please check the lo");
    document.body.removeChild(root);
  });

  it("an in-progress comment draft is unaffected by navigating away from the composer and back", () => {
    const root = attached();
    renderDetailPanel(root, task({ id: "T-0137", comments: manyComments(13) }), baseOpts());

    const input = root.querySelector(".detail-comment-input");
    input.focus();
    input.value = "still drafting this reply";

    stepDetailSection(root, 1); // moves focus elsewhere, no re-render involved
    focusDetailSection(root, "composer");

    expect(root.querySelector(".detail-comment-input").value).toBe("still drafting this reply");
    document.body.removeChild(root);
  });

  it("keeps focus and caret position on the comment textarea across a re-render (pre-existing guarantee, T-0137)", () => {
    const root = attached();
    renderDetailPanel(root, task({ id: "T-0137" }), baseOpts());

    const input = root.querySelector(".detail-comment-input");
    input.focus();
    input.value = "please check the log";
    input.setSelectionRange(7, 12);

    renderDetailPanel(root, task({ id: "T-0137" }), baseOpts());

    const newInput = root.querySelector(".detail-comment-input");
    expect(document.activeElement).toBe(newInput);
    expect(newInput.selectionStart).toBe(7);
    expect(newInput.selectionEnd).toBe(12);
    document.body.removeChild(root);
  });

  it("adds no new, removed or reordered task-data fields -- only navigation chrome (.detail-nav and landmark attributes)", () => {
    const root = attached();
    renderDetailPanel(root, task({ comments: manyComments(2) }), baseOpts());
    // Every pre-existing field selector from the original detailPanel.test.js suite still resolves.
    for (const selector of [
      ".detail-title",
      ".detail-priority",
      ".detail-status",
      ".detail-agent",
      ".detail-phase",
      ".detail-max-attempts",
      ".detail-complexity-points",
      ".detail-deps",
      ".detail-body-preview",
      ".detail-body-edit",
      ".detail-save",
      ".detail-comments",
      ".detail-attachments",
      ".detail-delete"
    ]) {
      expect(root.querySelector(selector), selector).not.toBeNull();
    }
    document.body.removeChild(root);
  });
});
