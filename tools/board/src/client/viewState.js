/**
 * Transient view state across model-driven re-renders.
 *
 * `renderBoard`, `renderDetailPanel`, `renderCreateForm` and friends all rebuild
 * their subtree from scratch (`replaceChildren`). That is fine for a view driven
 * purely by the model -- but the DOM also holds state the model knows nothing
 * about: which element has focus, where the caret is, what the user has typed but
 * not committed, how far a log is scrolled, which `<details>` are open, and
 * whether a native `<select>` popup is open right now.
 *
 * Every model update calls `render()`, and while agent tasks run those updates
 * arrive constantly -- one per run-event on the websocket, plus task mutations,
 * plus the 30s git-status poll. So a user interacting with the board is racing a
 * DOM rebuild the whole time. The confirmed symptom: open a column-sort
 * `<select>`, click an option, nothing happens -- the `<select>` was detached
 * before the click landed.
 *
 * This module is the general answer to that class, replacing the two one-off
 * patches that came before it (the comment textarea focus/caret restore, and the
 * dependency picker dirty-diff). Two layers, because one is not enough:
 *
 *   1. **Defer** (`createRenderGate`) -- while the user is inside a transient
 *      control, model-driven renders are held and coalesced, then flushed when
 *      the interaction ends. This is the only real fix for a native `<select>`:
 *      an open popup cannot be reopened programmatically, so the rebuild must
 *      not happen while it is open. User-initiated renders bypass the gate via
 *      `force()` -- a deferred render must never swallow a user action.
 *
 *   2. **Capture and restore** (`captureViewState` / `applyViewState`) -- for the
 *      renders that do proceed, focus, uncommitted text, caret/selection, scroll
 *      offsets and open `<details>` are carried across the rebuild.
 *
 * Elements are re-found after the rebuild by a positional path plus a signature
 * (tag + id + name + class + data-attributes). The path is the fast route; the
 * signature both validates it and provides the fallback when the tree shifted
 * underneath -- e.g. a card was added above the element the user was using.
 * Deliberately no selector strings: they would need escaping for ids like
 * `T-0001` and fail silently when they got it wrong.
 */

const TRANSIENT_TAGS = new Set(["SELECT", "INPUT", "TEXTAREA"]);

//: `<input type=...>` values that hold no user-entered state worth protecting --
//: focus on one of these means a click already committed, not an edit in flight.
const NON_ENTRY_INPUT_TYPES = new Set(["button", "submit", "reset", "image", "checkbox", "radio", "file"]);

function isContentEditable(el) {
  if (el.isContentEditable) return true;
  const attr = el.getAttribute?.("contenteditable");
  return attr === "" || attr === "true";
}

/** Does this element hold text the user may have typed but not committed? */
function isTextEntry(el) {
  if (!el || !el.tagName) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return !NON_ENTRY_INPUT_TYPES.has(type);
  }
  return isContentEditable(el);
}

/**
 * Is the user inside a control whose state a rebuild would destroy?
 *
 * A focused `<select>` counts: there is no DOM signal for "the popup is open",
 * and a focused select is either open or one keystroke from it. Buttons and
 * links do not count -- by the time they have focus their click has committed.
 */
export function isInteracting(root, doc) {
  if (!root) return false;
  const ownerDoc = doc ?? root.ownerDocument ?? globalThis.document;
  const active = ownerDoc?.activeElement;
  if (!active || active === ownerDoc.body || !root.contains(active)) return false;
  if (active.hasAttribute?.("data-transient")) return true;
  if (isContentEditable(active)) return true;
  if (!TRANSIENT_TAGS.has(active.tagName)) return false;
  if (active.tagName === "INPUT") {
    const type = (active.getAttribute("type") || "text").toLowerCase();
    if (NON_ENTRY_INPUT_TYPES.has(type)) return false;
  }
  return true;
}

/**
 * Opt-out for containers that own their scroll behaviour -- the run console sticks
 * to the bottom while the user is following live output, and a blind restore of the
 * previous offset would fight that on every event.
 */
function isScrollManaged(el) {
  return el?.dataset?.scrollManaged === "true";
}

function signatureOf(el) {
  const data = Object.entries(el.dataset ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("|");
  return [
    el.tagName,
    el.id || "",
    el.getAttribute?.("name") || "",
    el.getAttribute?.("class") || "",
    data
  ].join("");
}

function describe(el, root) {
  const path = [];
  let node = el;
  while (node && node !== root) {
    const parent = node.parentElement;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, node));
    node = parent;
  }
  if (node !== root) return null;
  return { path, signature: signatureOf(el) };
}

function elementAtPath(root, path) {
  let node = root;
  for (const index of path) {
    node = node?.children?.[index];
    if (!node) return null;
  }
  return node === root ? null : node;
}

/** Re-find a described element: exact position first, signature scan as fallback. */
function locate(root, descriptor) {
  if (!descriptor || !Array.isArray(descriptor.path)) return null;
  const atPath = elementAtPath(root, descriptor.path);
  if (atPath && signatureOf(atPath) === descriptor.signature) return atPath;
  for (const candidate of root.querySelectorAll("*")) {
    if (signatureOf(candidate) === descriptor.signature) return candidate;
  }
  return null;
}

/**
 * Snapshot the transient state inside *root* (and of *root* itself).
 *
 * Returns a plain object; `focus` is null when focus is elsewhere, which is what
 * keeps a render from stealing focus onto a field the user never touched.
 */
export function captureViewState(root, doc) {
  const empty = { focus: null, scrolls: [], details: [] };
  if (!root) return empty;
  const ownerDoc = doc ?? root.ownerDocument ?? globalThis.document;

  let focus = null;
  const active = ownerDoc?.activeElement;
  if (active && active !== ownerDoc.body && root.contains(active)) {
    const descriptor = describe(active, root);
    if (descriptor) {
      focus = descriptor;
      if (isTextEntry(active)) {
        focus.value = active.value;
        focus.selectionStart = active.selectionStart;
        focus.selectionEnd = active.selectionEnd;
      }
      if (active.scrollTop) focus.scrollTop = active.scrollTop;
    }
  }

  // The root itself is frequently THE scroll container (#detail, #console): only its
  // children get replaced, so a descendant-only scan would miss it.
  const rootScroll =
    !isScrollManaged(root) && (root.scrollTop || root.scrollLeft)
      ? { top: root.scrollTop, left: root.scrollLeft }
      : null;

  const scrolls = [];
  for (const el of root.querySelectorAll("*")) {
    if ((el.scrollTop || el.scrollLeft) && !isScrollManaged(el)) {
      const descriptor = describe(el, root);
      if (descriptor) scrolls.push({ ...descriptor, top: el.scrollTop, left: el.scrollLeft });
    }
  }

  const details = [];
  for (const el of root.querySelectorAll("details")) {
    if (el.open) {
      const descriptor = describe(el, root);
      if (descriptor) details.push(descriptor);
    }
  }

  return { focus, rootScroll, scrolls, details };
}

/** Re-apply a snapshot after the subtree has been rebuilt. Never throws. */
export function applyViewState(root, snapshot) {
  if (!root || !snapshot) return;

  // Open state first: a restored `<details>` changes the layout that scroll
  // offsets and focus are measured against.
  for (const descriptor of snapshot.details ?? []) {
    const el = locate(root, descriptor);
    if (el) el.open = true;
  }

  if (snapshot.rootScroll) {
    root.scrollTop = snapshot.rootScroll.top;
    root.scrollLeft = snapshot.rootScroll.left;
  }

  for (const entry of snapshot.scrolls ?? []) {
    const el = locate(root, entry);
    if (el) {
      el.scrollTop = entry.top;
      el.scrollLeft = entry.left;
    }
  }

  const focus = snapshot.focus;
  if (!focus) return;
  const el = locate(root, focus);
  if (!el) return;

  // Uncommitted text goes back before focus, so the caret lands in the restored
  // string rather than in whatever the model rebuilt the field with.
  if (typeof focus.value === "string" && isTextEntry(el) && el.value !== focus.value) {
    el.value = focus.value;
  }

  try {
    el.focus({ preventScroll: true });
  } catch {
    // Not focusable any more (disabled, or rebuilt as a different control).
    return;
  }

  if (typeof focus.selectionStart === "number" && typeof el.setSelectionRange === "function") {
    try {
      el.setSelectionRange(focus.selectionStart, focus.selectionEnd ?? focus.selectionStart);
    } catch {
      // Selection is not supported on this input type (e.g. number, email).
    }
  }

  if (focus.scrollTop) el.scrollTop = focus.scrollTop;
}

/**
 * A render gate: holds model-driven renders while the user is interacting.
 *
 * - `request()`     -- a model-driven render. Deferred (and coalesced) if the
 *                      user is mid-interaction; returns whether it rendered.
 * - `flushIfIdle()` -- render a deferred update, but only once the user is out
 *                      of the control. This is what interaction-end events wire
 *                      to: `focusout` fires *before* focus settles, and tabbing
 *                      straight from one `<select>` to the next must not open a
 *                      rebuild window in between.
 * - `flush()`       -- render a deferred update unconditionally.
 * - `force()`       -- render regardless, and discharge anything deferred. For
 *                      user-initiated updates, which the gate must never swallow.
 * - `pending()`     -- is a deferred render waiting?
 *
 * `roots` accepts several subtrees because the board renders into five separate
 * roots (board, detail panel, console, create form, git status) and focus can be
 * in any of them.
 */
export function createRenderGate({ render, root, roots, doc }) {
  const watched = (roots ?? (root ? [root] : [])).filter(Boolean);
  const ownerDoc = doc ?? watched[0]?.ownerDocument ?? globalThis.document;
  let deferred = false;
  let pointerDown = false;
  let dragging = false;

  function interacting() {
    // A held pointer outranks everything else. A `click` is only dispatched to the
    // nearest common ancestor of the mousedown and mouseup targets, so a rebuild
    // between them means NO click event fires at all -- silently, for every button
    // on the page. Holding renders for the gesture is what closes that window.
    if (pointerDown || dragging) return true;
    return watched.some((candidate) => isInteracting(candidate, ownerDoc));
  }

  const gate = {
    request() {
      if (interacting()) {
        deferred = true;
        return false;
      }
      deferred = false;
      render();
      return true;
    },
    flush() {
      if (!deferred) return false;
      deferred = false;
      render();
      return true;
    },
    flushIfIdle() {
      if (!deferred || interacting()) return false;
      deferred = false;
      render();
      return true;
    },
    force() {
      deferred = false;
      render();
      return true;
    },
    pending() {
      return deferred;
    },
    interacting,

    /**
     * Start watching for gestures. Returns a detach function.
     *
     * Listeners are capture-phase on the document so they see the gesture even if a
     * handler below stops propagation, and so a pointerdown anywhere -- including on
     * a `<select>`, whose popup opens on press -- holds renders off.
     */
    attach() {
      if (!ownerDoc?.addEventListener) return () => {};

      const onPointerDown = () => {
        pointerDown = true;
      };
      const onPointerRelease = () => {
        pointerDown = false;
        gate.flushIfIdle();
      };
      const onDragStart = () => {
        dragging = true;
      };
      const onDragEnd = () => {
        dragging = false;
        gate.flushIfIdle();
      };
      // focusout fires before focus settles, and change fires while the control is
      // still focused -- flushIfIdle re-checks rather than trusting the event.
      const onInteractionEnd = () => gate.flushIfIdle();

      const bindings = [
        ["pointerdown", onPointerDown],
        ["pointerup", onPointerRelease],
        ["pointercancel", onPointerRelease],
        ["dragstart", onDragStart],
        ["dragend", onDragEnd],
        ["drop", onDragEnd],
        ["focusout", onInteractionEnd],
        ["change", onInteractionEnd]
      ];
      for (const [type, handler] of bindings) {
        ownerDoc.addEventListener(type, handler, true);
      }

      return () => {
        for (const [type, handler] of bindings) {
          ownerDoc.removeEventListener(type, handler, true);
        }
        pointerDown = false;
        dragging = false;
      };
    }
  };

  return gate;
}
