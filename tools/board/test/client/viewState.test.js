// @vitest-environment happy-dom
/**
 * Transient view-state preservation across model-driven re-renders.
 *
 * The board rebuilds its entire DOM (`root.replaceChildren()`) on every model
 * update, and while agent tasks run those updates arrive constantly (one per
 * run-event on the websocket). Anything the user is mid-interaction with is
 * destroyed: the confirmed symptom is that opening a column-sort `<select>` and
 * clicking an option does nothing, because the `<select>` is detached before the
 * click lands.
 *
 * Two layers are tested here:
 *   1. an interaction gate  -- while the user is inside a transient control, a
 *      model-driven render is DEFERRED and coalesced, then flushed when the
 *      interaction ends. A native `<select>` popup cannot be reopened
 *      programmatically, so for that surface deferral is the only real fix.
 *   2. capture/restore      -- for renders that do proceed, focus, caret,
 *      selection, scroll offsets and open `<details>` survive the rebuild.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  captureViewState,
  applyViewState,
  isInteracting,
  createRenderGate
} from "../../src/client/viewState.js";

function mount(html) {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.replaceChildren(root);
  return root;
}

beforeEach(() => {
  document.body.replaceChildren();
});

// ---------------------------------------------------------------- isInteracting

describe("isInteracting", () => {
  it("is false when nothing inside the root has focus", () => {
    const root = mount('<select class="column-sort" data-status="ready"></select>');
    expect(isInteracting(root)).toBe(false);
  });

  it("is true while a select has focus -- a focused select is an open or about-to-open popup", () => {
    const root = mount('<select class="column-sort" data-status="ready"></select>');
    root.querySelector("select").focus();
    expect(isInteracting(root)).toBe(true);
  });

  it("is true while a text input has focus", () => {
    const root = mount('<input type="text" name="title">');
    root.querySelector("input").focus();
    expect(isInteracting(root)).toBe(true);
  });

  it("is true while a textarea has focus", () => {
    const root = mount("<textarea></textarea>");
    root.querySelector("textarea").focus();
    expect(isInteracting(root)).toBe(true);
  });

  it("is true while a contenteditable has focus", () => {
    const root = mount('<div contenteditable="true" tabindex="0"></div>');
    root.querySelector("[contenteditable]").focus();
    expect(isInteracting(root)).toBe(true);
  });

  it("is false for a focused plain button -- a click already committed, nothing to lose", () => {
    const root = mount('<button class="card-run">Run</button>');
    root.querySelector("button").focus();
    expect(isInteracting(root)).toBe(false);
  });

  it("ignores focus outside the root it was asked about", () => {
    const root = mount('<select class="column-sort"></select>');
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();
    expect(isInteracting(root)).toBe(false);
  });

  it("treats an element opted in with data-transient as interacting", () => {
    const root = mount('<div data-transient="menu" tabindex="0"></div>');
    root.querySelector("[data-transient]").focus();
    expect(isInteracting(root)).toBe(true);
  });
});

// ---------------------------------------------------------------- render gate

describe("createRenderGate", () => {
  it("renders immediately when the user is not interacting", () => {
    const root = mount("<div></div>");
    const render = vi.fn();
    const gate = createRenderGate({ render, root });

    gate.request();

    expect(render).toHaveBeenCalledTimes(1);
  });

  it("defers a render while a select has focus -- the sort-dropdown regression", () => {
    const root = mount('<select class="column-sort" data-status="ready"></select>');
    root.querySelector("select").focus();
    const render = vi.fn();
    const gate = createRenderGate({ render, root });

    gate.request();

    expect(render).not.toHaveBeenCalled();
    expect(gate.pending()).toBe(true);
  });

  it("coalesces many deferred renders into exactly one flush", () => {
    const root = mount('<select class="column-sort"></select>');
    root.querySelector("select").focus();
    const render = vi.fn();
    const gate = createRenderGate({ render, root });

    for (let i = 0; i < 25; i += 1) gate.request();
    expect(render).not.toHaveBeenCalled();

    gate.flush();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("flush is a no-op when nothing was deferred", () => {
    const root = mount("<div></div>");
    const render = vi.fn();
    const gate = createRenderGate({ render, root });

    gate.flush();

    expect(render).not.toHaveBeenCalled();
  });

  it("clears the pending flag once flushed", () => {
    const root = mount('<select class="column-sort"></select>');
    root.querySelector("select").focus();
    const render = vi.fn();
    const gate = createRenderGate({ render, root });

    gate.request();
    gate.flush();

    expect(gate.pending()).toBe(false);
  });

  it("force() renders even mid-interaction -- a user action must never be swallowed", () => {
    const root = mount('<select class="column-sort"></select>');
    root.querySelector("select").focus();
    const render = vi.fn();
    const gate = createRenderGate({ render, root });

    gate.force();

    expect(render).toHaveBeenCalledTimes(1);
  });

  it("force() also discharges anything that was deferred", () => {
    const root = mount('<select class="column-sort"></select>');
    root.querySelector("select").focus();
    const render = vi.fn();
    const gate = createRenderGate({ render, root });

    gate.request();
    gate.force();

    expect(render).toHaveBeenCalledTimes(1);
    expect(gate.pending()).toBe(false);
  });

  it("resumes immediate rendering once the interaction ends", () => {
    const root = mount('<select class="column-sort"></select>');
    const select = root.querySelector("select");
    select.focus();
    const render = vi.fn();
    const gate = createRenderGate({ render, root });

    gate.request();
    expect(render).not.toHaveBeenCalled();

    select.blur();
    gate.request();

    expect(render).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- capture/restore

describe("captureViewState / applyViewState", () => {
  it("restores focus to the same logical element after the DOM is replaced", () => {
    const root = mount('<select class="column-sort" data-status="ready"></select>');
    root.querySelector("select").focus();

    const snapshot = captureViewState(root);
    root.innerHTML = '<select class="column-sort" data-status="ready"></select>';
    applyViewState(root, snapshot);

    expect(document.activeElement).toBe(root.querySelector("select"));
  });

  it("picks the right element when several share a tag, keyed on its data attribute", () => {
    const root = mount(
      '<select class="column-sort" data-status="backlog"></select>' +
        '<select class="column-sort" data-status="ready"></select>' +
        '<select class="column-sort" data-status="done"></select>'
    );
    root.querySelector('[data-status="ready"]').focus();

    const snapshot = captureViewState(root);
    root.innerHTML =
      '<select class="column-sort" data-status="backlog"></select>' +
      '<select class="column-sort" data-status="ready"></select>' +
      '<select class="column-sort" data-status="done"></select>';
    applyViewState(root, snapshot);

    expect(document.activeElement.dataset.status).toBe("ready");
  });

  it("preserves a half-typed value and the caret position across a re-render", () => {
    const root = mount('<input type="text" name="title" value="half typed">');
    const input = root.querySelector("input");
    input.focus();
    input.selectionStart = 4;
    input.selectionEnd = 4;

    const snapshot = captureViewState(root);
    // The re-render rebuilds the field from the model, losing the uncommitted text.
    root.innerHTML = '<input type="text" name="title" value="">';
    applyViewState(root, snapshot);

    const restored = root.querySelector("input");
    expect(restored.value).toBe("half typed");
    expect(restored.selectionStart).toBe(4);
    expect(restored.selectionEnd).toBe(4);
  });

  it("preserves a selection range, not just a collapsed caret", () => {
    const root = mount("<textarea>the quick brown fox</textarea>");
    const ta = root.querySelector("textarea");
    ta.focus();
    ta.setSelectionRange(4, 9);

    const snapshot = captureViewState(root);
    root.innerHTML = "<textarea></textarea>";
    applyViewState(root, snapshot);

    const restored = root.querySelector("textarea");
    expect(restored.selectionStart).toBe(4);
    expect(restored.selectionEnd).toBe(9);
  });

  it("does not clobber a value the user never touched", () => {
    const root = mount('<input type="text" name="title" value="">');
    const snapshot = captureViewState(root);
    root.innerHTML = '<input type="text" name="title" value="from the model">';
    applyViewState(root, snapshot);

    expect(root.querySelector("input").value).toBe("from the model");
  });

  it("restores scroll offsets of scrollable containers", () => {
    const root = mount('<div class="console-log" data-scroll-key="log"></div>');
    const log = root.querySelector(".console-log");
    log.scrollTop = 250;
    log.scrollLeft = 40;

    const snapshot = captureViewState(root);
    root.innerHTML = '<div class="console-log" data-scroll-key="log"></div>';
    applyViewState(root, snapshot);

    const restored = root.querySelector(".console-log");
    expect(restored.scrollTop).toBe(250);
    expect(restored.scrollLeft).toBe(40);
  });

  it("restores open <details> sections", () => {
    const root = mount('<details data-section="attachments" open></details><details data-section="log"></details>');

    const snapshot = captureViewState(root);
    root.innerHTML = '<details data-section="attachments"></details><details data-section="log"></details>';
    applyViewState(root, snapshot);

    expect(root.querySelector('[data-section="attachments"]').open).toBe(true);
    expect(root.querySelector('[data-section="log"]').open).toBe(false);
  });

  it("survives the focused element disappearing entirely", () => {
    const root = mount('<input type="text" name="gone">');
    root.querySelector("input").focus();

    const snapshot = captureViewState(root);
    root.innerHTML = "<div>replaced by something else</div>";

    expect(() => applyViewState(root, snapshot)).not.toThrow();
  });

  it("captures nothing when focus is outside the root", () => {
    const root = mount('<input type="text" name="title">');
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.focus();

    const snapshot = captureViewState(root);

    expect(snapshot.focus).toBeNull();
  });

  it("applying a null/empty snapshot is a no-op, not a crash", () => {
    const root = mount('<input type="text">');
    expect(() => applyViewState(root, null)).not.toThrow();
    expect(() => applyViewState(root, captureViewState(root))).not.toThrow();
  });

  it("does not steal focus when nothing was focused before the render", () => {
    const root = mount('<input type="text" name="title">');
    const snapshot = captureViewState(root);
    root.innerHTML = '<input type="text" name="title">';
    applyViewState(root, snapshot);

    expect(document.activeElement).not.toBe(root.querySelector("input"));
  });
});

// ---------------------------------------------------------------- multi-root + idle flush

describe("createRenderGate across several roots", () => {
  it("defers when focus is in any watched root, not just the first", () => {
    const board = document.createElement("div");
    const panel = document.createElement("div");
    panel.innerHTML = '<textarea class="comment-input"></textarea>';
    document.body.replaceChildren(board, panel);
    panel.querySelector("textarea").focus();

    const render = vi.fn();
    const gate = createRenderGate({ render, roots: [board, panel] });

    gate.request();

    expect(render).not.toHaveBeenCalled();
    expect(gate.pending()).toBe(true);
  });

  it("renders when focus is in none of the watched roots", () => {
    const board = document.createElement("div");
    const panel = document.createElement("div");
    document.body.replaceChildren(board, panel);

    const render = vi.fn();
    const gate = createRenderGate({ render, roots: [board, panel] });

    gate.request();

    expect(render).toHaveBeenCalledTimes(1);
  });

  it("tolerates null roots -- the panels are optional in the board bootstrap", () => {
    const board = document.createElement("div");
    document.body.replaceChildren(board);

    const render = vi.fn();
    const gate = createRenderGate({ render, roots: [board, null, undefined] });

    expect(() => gate.request()).not.toThrow();
    expect(render).toHaveBeenCalledTimes(1);
  });
});

describe("flushIfIdle", () => {
  it("does not render while the user is still inside the control", () => {
    const root = mount('<select class="column-sort"></select>');
    root.querySelector("select").focus();
    const render = vi.fn();
    const gate = createRenderGate({ render, root });

    gate.request();
    gate.flushIfIdle();

    expect(render).not.toHaveBeenCalled();
    expect(gate.pending()).toBe(true);
  });

  it("renders the deferred update once the control is left", () => {
    const root = mount('<select class="column-sort"></select>');
    const select = root.querySelector("select");
    select.focus();
    const render = vi.fn();
    const gate = createRenderGate({ render, root });

    gate.request();
    select.blur();
    gate.flushIfIdle();

    expect(render).toHaveBeenCalledTimes(1);
    expect(gate.pending()).toBe(false);
  });

  it("does nothing when no render was deferred", () => {
    const root = mount("<div></div>");
    const render = vi.fn();
    const gate = createRenderGate({ render, root });

    expect(gate.flushIfIdle()).toBe(false);
    expect(render).not.toHaveBeenCalled();
  });

  it("keeps deferring when focus moves straight from one select to the next", () => {
    const root = mount(
      '<select class="column-sort" data-status="ready"></select>' +
        '<select class="column-sort" data-status="done"></select>'
    );
    const [first, second] = root.querySelectorAll("select");
    first.focus();
    const render = vi.fn();
    const gate = createRenderGate({ render, root });

    gate.request();
    second.focus(); // tabbing across; focusout on the first has already fired
    gate.flushIfIdle();

    expect(render).not.toHaveBeenCalled();
    expect(gate.pending()).toBe(true);
  });
});

// ---------------------------------------------------------------- pointer / drag gating

/**
 * The general form of the reported bug, and the most severe: a `click` is only
 * dispatched to the nearest common ancestor of the mousedown and mouseup
 * targets. A render between the two replaces the node, leaving no common
 * ancestor, so **no click event fires at all** -- silently, on every button on
 * the page, not just the sort dropdown. Holding renders for the duration of a
 * pointer gesture is what closes that window.
 */
describe("createRenderGate pointer gating", () => {
  function gateWith(render) {
    const root = document.createElement("div");
    root.innerHTML = '<button class="card-run">Run</button>';
    document.body.replaceChildren(root);
    const gate = createRenderGate({ render, root });
    const detach = gate.attach();
    return { root, gate, detach };
  }

  it("defers a render while a pointer button is held down", () => {
    const render = vi.fn();
    const { root, gate, detach } = gateWith(render);

    root.querySelector("button").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    gate.request();

    expect(render).not.toHaveBeenCalled();
    expect(gate.pending()).toBe(true);
    detach();
  });

  it("flushes once the pointer is released, so the click still lands first", () => {
    const render = vi.fn();
    const { root, gate, detach } = gateWith(render);
    const button = root.querySelector("button");

    button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    gate.request();
    expect(render).not.toHaveBeenCalled();

    button.dispatchEvent(new Event("pointerup", { bubbles: true }));

    expect(render).toHaveBeenCalledTimes(1);
    detach();
  });

  it("the click handler still fires on the original element across a deferred render", () => {
    const render = vi.fn();
    const { root, gate, detach } = gateWith(render);
    const button = root.querySelector("button");
    const onClick = vi.fn();
    button.addEventListener("click", onClick);

    // A realistic gesture with a model update arriving mid-press.
    button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    gate.request();
    button.dispatchEvent(new Event("pointerup", { bubbles: true }));
    button.dispatchEvent(new Event("click", { bubbles: true }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.isConnected).toBe(true);
    detach();
  });

  it("treats a cancelled pointer gesture as released", () => {
    const render = vi.fn();
    const { root, gate, detach } = gateWith(render);
    const button = root.querySelector("button");

    button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    gate.request();
    button.dispatchEvent(new Event("pointercancel", { bubbles: true }));

    expect(render).toHaveBeenCalledTimes(1);
    detach();
  });

  it("defers for the whole duration of a drag", () => {
    const render = vi.fn();
    const { root, gate, detach } = gateWith(render);
    const button = root.querySelector("button");

    button.dispatchEvent(new Event("dragstart", { bubbles: true }));
    gate.request();
    expect(render).not.toHaveBeenCalled();

    button.dispatchEvent(new Event("dragend", { bubbles: true }));
    expect(render).toHaveBeenCalledTimes(1);
    detach();
  });

  it("force() still renders mid-gesture -- a user action is never swallowed", () => {
    const render = vi.fn();
    const { root, gate, detach } = gateWith(render);

    root.querySelector("button").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    gate.force();

    expect(render).toHaveBeenCalledTimes(1);
    detach();
  });

  it("detach() stops the gate listening", () => {
    const render = vi.fn();
    const { root, gate, detach } = gateWith(render);
    detach();

    root.querySelector("button").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    gate.request();

    expect(render).toHaveBeenCalledTimes(1);
  });

  it("a stuck pointerdown cannot wedge the board forever -- a later pointerup clears it", () => {
    const render = vi.fn();
    const { root, gate, detach } = gateWith(render);
    const button = root.querySelector("button");

    button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    gate.request();
    button.dispatchEvent(new Event("pointerup", { bubbles: true }));

    expect(gate.pending()).toBe(false);
    expect(render).toHaveBeenCalledTimes(1);
    detach();
  });
});

// ---------------------------------------------------------------- the root's own scroll

/**
 * The detail panel and the console ARE the scroll containers (#detail, #console
 * in style.css) -- only their children are replaced. Scanning descendants misses
 * them entirely, which is why "scroll down to Save, lose your place" survived the
 * earlier fixes.
 */
describe("root scroll offset", () => {
  it("captures and restores the scroll offset of the root element itself", () => {
    const root = mount("<div>tall content</div>");
    root.scrollTop = 420;

    const snapshot = captureViewState(root);
    root.innerHTML = "<div>rebuilt content</div>";
    root.scrollTop = 0;
    applyViewState(root, snapshot);

    expect(root.scrollTop).toBe(420);
  });

  it("leaves an unscrolled root alone", () => {
    const root = mount("<div></div>");
    const snapshot = captureViewState(root);
    applyViewState(root, snapshot);
    expect(root.scrollTop).toBe(0);
  });

  it("skips a root that manages its own scroll", () => {
    const root = mount("<div></div>");
    root.dataset.scrollManaged = "true";
    root.scrollTop = 300;

    const snapshot = captureViewState(root);
    root.scrollTop = 0;
    applyViewState(root, snapshot);

    expect(root.scrollTop).toBe(0);
  });

  it("skips descendants that manage their own scroll", () => {
    const root = mount('<div class="log" data-scroll-managed="true"></div>');
    const log = root.querySelector(".log");
    log.scrollTop = 150;

    const snapshot = captureViewState(root);
    root.innerHTML = '<div class="log" data-scroll-managed="true"></div>';
    applyViewState(root, snapshot);

    expect(root.querySelector(".log").scrollTop).toBe(0);
  });
});
