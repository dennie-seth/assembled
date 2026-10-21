import { renderMarkdown } from "./markdown.js";
import { buildUpdateBody } from "./detail.js";
import { STATUSES } from "./board.js";
import { createDepsPicker } from "./depsPicker.js";
import { attachmentDownloadUrl } from "./api.js";

const PRIORITIES = ["P0", "P1", "P2", "P3"];
const UNASSIGNED_AGENT_VALUE = "";
const LIVE_RUN_STATUSES = new Set(["in-progress", "validation"]);

// Live updates (board socket "changed" events -- see app.js's handleSocketMessage) call
// renderDetailPanel again for the same, still-selected task on every server-side change,
// e.g. an in-progress card's `attempts` counter ticking up. Each call tears down and
// rebuilds the whole subtree from `task`, which used to wipe an un-submitted comment (or
// title/body) the user was mid-typing. Capture the focused field's value/caret before the
// teardown and restore it onto its freshly-built replacement so typing survives a re-render;
// switching to a different task, or a re-render while the field isn't focused, intentionally
// does not restore anything so a legitimate server-side change still wins.
const SELECTABLE_INPUT_TYPES = new Set(["text", "search", "url", "tel", "password"]);

// The focus-capture mechanism above only protects whichever single field currently has
// focus, so it never covered the deps picker (a compound <select>-plus-chips widget with
// no `data-detail-field` of its own) or the priority/status/agent selects, and it loses a
// field's edit the moment focus moves elsewhere (e.g. typing a title, then clicking into
// the deps picker to add a dependency) -- reported live as "when I'm trying to add a
// dependency and scroll down to save the task, the dependency gets removed before I even
// have a chance to save it." captureDirtyFields fixes this by diffing each editable
// field's *current* DOM value against `previousTask` (the task object the still-open panel
// was last built from, stashed on `root.__lastTask`) rather than relying on focus: any
// field whose live value has drifted from that baseline is a local, unsaved edit and gets
// carried into the rebuild verbatim; untouched fields keep reading straight from the new
// `task`, so a legitimate incoming change to a field the user didn't touch still lands.
function captureDirtyFields(root, previousTask) {
  if (!previousTask) return {};
  const dirty = {};

  const titleEl = root.querySelector(".detail-title");
  if (titleEl && titleEl.value !== previousTask.title) {
    dirty.title = titleEl.value;
  }

  const priorityEl = root.querySelector(".detail-priority");
  if (priorityEl && priorityEl.value !== previousTask.priority) {
    dirty.priority = priorityEl.value;
  }

  const statusEl = root.querySelector(".detail-status");
  if (statusEl && statusEl.value !== previousTask.status) {
    dirty.status = statusEl.value;
  }

  const agentEl = root.querySelector(".detail-agent");
  if (agentEl && agentEl.value !== (previousTask.agent ?? UNASSIGNED_AGENT_VALUE)) {
    dirty.agent = agentEl.value;
  }

  const phaseEl = root.querySelector(".detail-phase");
  if (phaseEl && phaseEl.value !== String(previousTask.phase)) {
    dirty.phase = phaseEl.value;
  }

  const maxAttemptsEl = root.querySelector(".detail-max-attempts");
  if (maxAttemptsEl) {
    const previousValue = previousTask.max_attempts != null ? String(previousTask.max_attempts) : "";
    if (maxAttemptsEl.value !== previousValue) {
      dirty.maxAttempts = maxAttemptsEl.value;
    }
  }

  const complexityPointsEl = root.querySelector(".detail-complexity-points");
  if (complexityPointsEl) {
    const previousValue = previousTask.complexity_points != null ? String(previousTask.complexity_points) : "";
    if (complexityPointsEl.value !== previousValue) {
      dirty.complexityPoints = complexityPointsEl.value;
    }
  }

  const chipIds = Array.from(root.querySelectorAll(".detail-deps-edit .deps-chip")).map(
    (chip) => chip.dataset.id
  );
  const previousDeps = previousTask.depends_on ?? [];
  if (JSON.stringify(chipIds) !== JSON.stringify(previousDeps)) {
    dirty.dependsOn = chipIds;
  }

  const bodyEl = root.querySelector(".detail-body-edit");
  if (bodyEl && bodyEl.value !== previousTask.body) {
    dirty.body = bodyEl.value;
  }

  // An un-submitted comment is user-authored data with no copy anywhere else --
  // losing it is the worst outcome on this panel. The focus/caret restore below only
  // covers it while it HAS focus; this covers a draft the user clicked away from.
  const commentEl = root.querySelector(".detail-comment-input");
  if (commentEl && commentEl.value.length > 0) {
    dirty.comment = commentEl.value;
  }

  // Delete-confirm is pure DOM state. A rebuild silently reverts it, so a user who
  // read the prompt and reached for "Yes, delete" ends up clicking a re-rendered
  // "Delete" button instead -- their confirmed intent dropped with no signal.
  const confirmEl = root.querySelector(".detail-delete-confirm");
  if (confirmEl && confirmEl.hidden === false) {
    dirty.deleteConfirmOpen = true;
  }

  return dirty;
}

function supportsSelectionRange(el) {
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") return SELECTABLE_INPUT_TYPES.has(el.type);
  return false;
}

function captureFocusState(root) {
  const active = document.activeElement;
  if (!active || !root.contains(active)) return null;
  const field = active.dataset?.detailField;
  if (!field) return null;

  const state = { field, value: active.value };
  if (supportsSelectionRange(active)) {
    state.selectionStart = active.selectionStart;
    state.selectionEnd = active.selectionEnd;
  }
  return state;
}

function restoreFocusState(root, focusState) {
  if (!focusState) return;
  const el = root.querySelector(`[data-detail-field="${focusState.field}"]`);
  if (!el) return;

  if (el.type !== "file") {
    el.value = focusState.value;
  }
  el.focus();
  if ("selectionStart" in focusState && typeof el.setSelectionRange === "function") {
    try {
      el.setSelectionRange(focusState.selectionStart, focusState.selectionEnd);
    } catch {
      // Some focusable input types (e.g. number) don't support selection ranges.
    }
  }
}

function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function labeledField(labelText, input) {
  const wrapper = document.createElement("label");
  wrapper.className = "detail-field";
  const label = document.createElement("span");
  label.textContent = labelText;
  wrapper.append(label, input);
  return wrapper;
}

function selectFor(options, selected) {
  const select = document.createElement("select");
  for (const value of options) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  }
  select.value = selected;
  return select;
}

// Mirrors COMPLEXITY_POINTS_VALUES in src/lib/taskParser.js (server-only module, not importable
// from the client bundle) -- the Fibonacci planning-only scale (T-0368, spec §2/§10 step 2).
const COMPLEXITY_POINTS_VALUES = [1, 2, 3, 5, 8, 13, 21];
const NO_SCORE_VALUE = "";

function complexityPointsSelectFor(selected) {
  const select = document.createElement("select");

  const noScore = document.createElement("option");
  noScore.value = NO_SCORE_VALUE;
  noScore.textContent = "No score";
  select.appendChild(noScore);

  for (const value of COMPLEXITY_POINTS_VALUES) {
    const opt = document.createElement("option");
    opt.value = String(value);
    opt.textContent = String(value);
    select.appendChild(opt);
  }
  select.value = selected;
  return select;
}

function agentSelectFor(agentOptions, currentAgent) {
  const select = document.createElement("select");

  const unassigned = document.createElement("option");
  unassigned.value = UNASSIGNED_AGENT_VALUE;
  unassigned.textContent = "Unassigned";
  select.appendChild(unassigned);

  const names = new Set(agentOptions);
  if (currentAgent) {
    names.add(currentAgent);
  }
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  select.value = currentAgent ?? UNASSIGNED_AGENT_VALUE;
  return select;
}

function branchInfoFor(task) {
  if (!task.branch) return null;
  const info = document.createElement("div");
  info.className = "detail-branch";
  const commitSuffix = task.commit ? ` · Commit: ${task.commit.slice(0, 10)}` : "";
  info.textContent = `Branch: ${task.branch}${commitSuffix}`;
  return info;
}

// Mirrors MAX_AUTO_RETRY_ATTEMPTS in src/runner/runOrchestrator.js (server-only module, not
// importable from the client bundle) -- the bounded FAIL -> auto-retry loop's cap.
const MAX_AUTO_RETRY_ATTEMPTS = 5;

function attemptsInfoFor(task) {
  if (!task.attempts) return null;
  // T-0343: a card's own max_attempts overrides the default cap shown here.
  const cap = Number.isInteger(task.max_attempts) ? task.max_attempts : MAX_AUTO_RETRY_ATTEMPTS;
  const info = document.createElement("div");
  info.className = "detail-attempts";
  info.textContent = `Auto-retry: run ${task.attempts} of ${cap}`;
  return info;
}

const DRAIN_HELD_STATUSES = new Set(["held_oversized", "held_wait_expired"]);

/**
 * WIP gate T-F (drain mode, spec §9), FIX ROUND 1 finding (b): "a waiting card shows the
 * blocking window and the next reconsideration time" -- on the card detail panel as well as the
 * board. `drainState` is this card's own entry from GET /api/poller's `drain` map (or the
 * `drain_state` computed field), threaded straight through by app.js.
 */
function drainSummaryFor(drainState) {
  if (drainState.status === "waiting") {
    const windowLabel = drainState.blockingWindow ?? "capacity";
    const next =
      typeof drainState.nextReconsiderationAtMs === "number"
        ? new Date(drainState.nextReconsiderationAtMs).toLocaleString()
        : "unknown";
    return `Drain: waiting on ${windowLabel} window -- next reconsideration ${next}`;
  }
  if (drainState.status === "held_oversized") {
    return `Drain hold (oversized): ${drainState.reason ?? "waiting cannot help -- split or re-scope this card"}`;
  }
  if (drainState.status === "held_wait_expired") {
    return `Drain hold (wait expired): ${drainState.reason ?? "bounded wait exceeded -- needs a human to intervene"}`;
  }
  return `Drain: ${drainState.status}`;
}

function drainInfoFor(drainState) {
  if (!drainState || !drainState.status || drainState.status === "clear") return null;
  const info = document.createElement("div");
  info.className = DRAIN_HELD_STATUSES.has(drainState.status) ? "detail-drain detail-drain-held" : "detail-drain";
  info.textContent = drainSummaryFor(drainState);
  return info;
}

function commentsSectionFor(task, onAddComment) {
  const wrap = document.createElement("div");
  wrap.className = "detail-comments";

  const heading = document.createElement("h3");
  heading.textContent = "Comments";
  wrap.appendChild(heading);

  const list = document.createElement("div");
  list.className = "detail-comments-list";
  const comments = task.comments ?? [];
  if (comments.length === 0) {
    const empty = document.createElement("div");
    empty.className = "detail-comments-empty";
    empty.textContent = "No comments yet.";
    list.appendChild(empty);
  } else {
    for (const comment of comments) {
      const item = document.createElement("div");
      item.className = "detail-comment";

      const meta = document.createElement("div");
      meta.className = "detail-comment-meta";
      meta.textContent = `${comment.author} · ${comment.timestamp}`;

      const text = document.createElement("div");
      text.className = "detail-comment-text";
      text.textContent = comment.text;

      item.append(meta, text);
      list.appendChild(item);
    }
  }
  wrap.appendChild(list);

  const input = document.createElement("textarea");
  input.className = "detail-comment-input";
  input.placeholder = "Add a comment...";
  input.dataset.detailField = "comment";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "detail-comment-add";
  addBtn.textContent = "Add comment";
  addBtn.addEventListener("click", () => {
    const text = input.value.trim();
    if (text.length === 0) return;
    onAddComment(task.id, text);
    input.value = "";
  });

  // T-0462 FIX ROUND 2: the composer *section target* is this group wrapper, not the textarea
  // itself. Landing sequential/direct navigation inside a real <textarea> made every subsequent
  // Alt+Arrow a dead stop -- shouldIgnoreDetailNavKey (app.js) correctly treats text-entry focus
  // as "the user is typing" and suppresses further shortcuts (criterion 3 requires exactly that).
  // A non-text-entry group landmark that *contains* the textarea gives navigation a real,
  // substantial, visibly-focusable target (so keyboard users still see where they landed) while
  // leaving the textarea itself one plain Tab away to actually start typing -- and leaving its
  // own suppression behaviour, once real focus is in it, completely untouched.
  const composerLandmark = document.createElement("div");
  composerLandmark.className = "detail-composer-landmark";
  composerLandmark.tabIndex = -1;
  composerLandmark.setAttribute("role", "group");
  composerLandmark.setAttribute("aria-label", "Comment composer");
  composerLandmark.append(input, addBtn);

  wrap.append(composerLandmark);
  return wrap;
}

function attachmentsSectionFor(task, onUploadAttachment, onRemoveAttachment) {
  const wrap = document.createElement("div");
  wrap.className = "detail-attachments";

  const heading = document.createElement("h3");
  heading.textContent = "Attachments";
  wrap.appendChild(heading);

  const list = document.createElement("div");
  list.className = "detail-attachments-list";
  const attachments = task.attachments ?? [];
  if (attachments.length === 0) {
    const empty = document.createElement("div");
    empty.className = "detail-attachments-empty";
    empty.textContent = "No attachments yet.";
    list.appendChild(empty);
  } else {
    for (const attachment of attachments) {
      const item = document.createElement("div");
      item.className = "detail-attachment";

      const url = attachmentDownloadUrl(task.id, attachment.filename);

      if (typeof attachment.mimetype === "string" && attachment.mimetype.startsWith("image/")) {
        const thumb = document.createElement("img");
        thumb.className = "detail-attachment-thumb";
        thumb.src = url;
        thumb.alt = attachment.filename;
        item.appendChild(thumb);
      }

      const link = document.createElement("a");
      link.className = "detail-attachment-link";
      link.href = url;
      link.textContent = `${attachment.filename} (${formatBytes(attachment.size)})`;
      item.appendChild(link);

      if (onRemoveAttachment) {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "detail-attachment-remove";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", () => onRemoveAttachment(task.id, attachment.filename));
        item.appendChild(removeBtn);
      }

      list.appendChild(item);
    }
  }
  wrap.appendChild(list);

  if (onUploadAttachment) {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.className = "detail-attachment-input";
    fileInput.dataset.detailField = "attachment";
    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      if (!file) return;
      onUploadAttachment(task.id, file);
      fileInput.value = "";
    });
    wrap.appendChild(fileInput);
  }

  return wrap;
}

// --- Section navigation (T-0462) -------------------------------------------------------
//
// On a long card (T-0436: 13 comments, several multi-screen) the compose box and the
// attachments were reachable only by scrolling the entire comment thread. These functions
// discover a fixed set of named landmarks already present in the rendered panel -- a group
// wrapping the title (top), the markdown body preview, the Acceptance heading inside that
// rendered markdown (if any), the latest comment, a group wrapping the composer, and the
// attachments heading -- and move focus directly to one of them. A section with no
// corresponding element for this task (no comments yet, no attachments callback) is simply
// absent from the list, never a dead stop.
//
// "top" and "composer" land on a *wrapping group*, not the title <input>/comment <textarea>
// themselves (FIX ROUND 2): real focus inside a text-entry element correctly suppresses every
// further navigation keystroke (shouldIgnoreDetailNavKey in app.js, required by this card's own
// "never fire while typing" criterion), so targeting the input/textarea directly made the very
// first sequential step -- nothing focused yet -> lands on "top" -- a permanent dead end. The
// group is a real, visible, substantial focus target (so a sighted keyboard user still sees
// where they landed) that *contains* the input; the input itself is still one plain Tab away,
// unchanged, for actually typing.
//
// Deliberately stateless: "current position" is read from document.activeElement every call
// rather than tracked separately, so switching to a different, already-rendered task can never
// carry a stale index or element reference -- there is nothing to carry. Sections are
// re-queried from the live DOM on every call (never cached), so a comment arriving over the
// socket while the panel is open is reflected the next time someone navigates.
const SECTION_LABELS = {
  top: "Top",
  body: "Body",
  acceptance: "Acceptance",
  comments: "Latest comment",
  composer: "Composer",
  attachments: "Attachments"
};

function findBodyLandmark(root) {
  const preview = root.querySelector(".detail-body-preview");
  if (!preview) return null;
  preview.tabIndex = -1;
  preview.setAttribute("role", "region");
  preview.setAttribute("aria-label", "Body");
  return preview;
}

function findAcceptanceHeading(root) {
  const preview = root.querySelector(".detail-body-preview");
  if (!preview) return null;
  for (const heading of preview.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    if (/acceptance/i.test(heading.textContent)) {
      heading.tabIndex = -1;
      return heading;
    }
  }
  return null;
}

function findLatestComment(root) {
  const items = root.querySelectorAll(".detail-comment");
  if (items.length === 0) return null;
  const latest = items[items.length - 1];
  latest.tabIndex = -1;
  const meta = latest.querySelector(".detail-comment-meta");
  latest.setAttribute("aria-label", meta ? `Latest comment: ${meta.textContent}` : "Latest comment");
  return latest;
}

function findComposerLandmark(root) {
  return root.querySelector(".detail-composer-landmark");
}

function findTopLandmark(root) {
  return root.querySelector(".detail-top-landmark");
}

function findAttachmentsLandmark(root) {
  const el = root.querySelector(".detail-attachments");
  if (el) {
    el.tabIndex = -1;
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", "Attachments");
  }
  return el;
}

const SECTION_FINDERS = [
  ["top", findTopLandmark],
  ["body", findBodyLandmark],
  ["acceptance", findAcceptanceHeading],
  ["comments", findLatestComment],
  ["composer", findComposerLandmark],
  ["attachments", findAttachmentsLandmark]
];

// FIX ROUND 3: SECTION_FINDERS above is a lookup table, not a reading-order declaration -- the
// panel's actual append order (renderDetailPanel) puts the comments section (with the composer
// inside it) and then attachments BEFORE the body preview (and the Acceptance heading nested
// inside that), not after. Sorting by compareDocumentPosition here means the returned order
// always matches whatever renderDetailPanel actually put on the page, so this list cannot drift
// out of sync with it again the next time the panel's layout changes.
function byDocumentPosition(a, b) {
  const rel = a.element.compareDocumentPosition(b.element);
  if (rel & (Node.DOCUMENT_POSITION_FOLLOWING | Node.DOCUMENT_POSITION_CONTAINED_BY)) return -1;
  if (rel & (Node.DOCUMENT_POSITION_PRECEDING | Node.DOCUMENT_POSITION_CONTAINS)) return 1;
  return 0;
}

/** Every named section this task's rendered panel currently has, in actual document order. */
export function listDetailSections(root) {
  if (!root) return [];
  const sections = [];
  for (const [key, find] of SECTION_FINDERS) {
    const element = find(root);
    if (element) {
      element.dataset.detailSection = key;
      sections.push({ key, label: SECTION_LABELS[key], element });
    }
  }
  sections.sort(byDocumentPosition);
  return sections;
}

// The Acceptance heading lives INSIDE the body preview's rendered markdown, so the body
// landmark .contains() it too -- a plain first-match search would always resolve focus on the
// heading back to "body", never "acceptance". An exact match wins immediately; among
// .contains() matches (nested landmarks, or a focusable descendant inside one, e.g. a
// remove-attachment button inside the attachments region), the most specific (innermost) one
// wins.
function currentSectionIndex(root, sections) {
  const active = (root.ownerDocument ?? document).activeElement;
  if (!active) return -1;
  let bestIndex = -1;
  for (let i = 0; i < sections.length; i++) {
    const element = sections[i].element;
    if (element === active) return i;
    if (element.contains(active)) {
      if (bestIndex === -1 || sections[bestIndex].element.contains(element)) {
        bestIndex = i;
      }
    }
  }
  return bestIndex;
}

function updateNavDisplay(root, sections, index) {
  const current = root.querySelector(".detail-nav-current");
  const jump = root.querySelector(".detail-nav-jump");
  const prevBtn = root.querySelector(".detail-nav-prev");
  const nextBtn = root.querySelector(".detail-nav-next");
  const section = sections[index];
  if (current) current.textContent = section ? `Section: ${section.label}` : "";
  if (jump && section) jump.value = section.key;
  if (prevBtn) prevBtn.disabled = index === 0;
  if (nextBtn) nextBtn.disabled = sections.length > 0 && index === sections.length - 1;
}

function applyFocus(root, sections, index) {
  const section = sections[index];
  if (!section) return null;
  section.element.focus({ preventScroll: true });
  if (typeof section.element.scrollIntoView === "function") {
    // `block: "center"` plus the `scroll-margin-top` every `[data-detail-section]` carries
    // (style.css) together keep the sticky .detail-nav bar from ever landing on top of the
    // section we just jumped to -- scrollIntoView expands the target rect by its scroll-margin
    // before aligning, so even a section scrolled to the very start/end of #detail keeps that
    // much clearance above it instead of parking flush under the bar.
    section.element.scrollIntoView({ block: "center" });
  }
  updateNavDisplay(root, sections, index);
  return section.key;
}

/**
 * Move to the next (1) or previous (-1) section relative to wherever focus currently is.
 * Clamped at both ends -- repeating the key at the last section stops there rather than
 * wrapping back to the top, so the Prev/Next disabled state (updateNavDisplay) is always a
 * true boundary signal rather than something wrapping could silently hide.
 */
export function stepDetailSection(root, direction) {
  const sections = listDetailSections(root);
  if (sections.length === 0) return null;
  const index = currentSectionIndex(root, sections);
  const nextIndex =
    index === -1
      ? direction > 0
        ? 0
        : sections.length - 1
      : Math.max(0, Math.min(sections.length - 1, index + direction));
  return applyFocus(root, sections, nextIndex);
}

/**
 * Jump straight to a named section (e.g. "composer", "attachments") in one call -- no
 * intermediate section is ever focused along the way. Returns false without acting if this
 * task has no such section right now.
 */
export function focusDetailSection(root, key) {
  const sections = listDetailSections(root);
  const index = sections.findIndex((section) => section.key === key);
  if (index === -1) return false;
  return applyFocus(root, sections, index) !== null;
}

function detailNavBarFor(root) {
  const nav = document.createElement("div");
  nav.className = "detail-nav";
  nav.setAttribute("role", "navigation");
  nav.setAttribute("aria-label", "Card sections");

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "detail-nav-prev";
  prevBtn.textContent = "↑ Prev";
  prevBtn.setAttribute("aria-label", "Previous section");
  prevBtn.addEventListener("click", () => stepDetailSection(root, -1));

  const jump = document.createElement("select");
  jump.className = "detail-nav-jump";
  jump.setAttribute("aria-label", "Jump to section");
  jump.addEventListener("change", () => focusDetailSection(root, jump.value));

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "detail-nav-next";
  nextBtn.textContent = "↓ Next";
  nextBtn.setAttribute("aria-label", "Next section");
  nextBtn.addEventListener("click", () => stepDetailSection(root, 1));

  const current = document.createElement("span");
  current.className = "detail-nav-current";
  current.setAttribute("aria-live", "polite");

  nav.append(prevBtn, jump, nextBtn, current);
  return nav;
}

// Run once the whole panel subtree is attached to `root` -- the section finders above query
// `root` itself (e.g. the latest `.detail-comment`, the Acceptance heading inside the body
// preview), so this must come after every other section-owning builder has run.
function populateNavBar(root) {
  const sections = listDetailSections(root);
  const jump = root.querySelector(".detail-nav-jump");
  if (jump) {
    jump.replaceChildren(
      ...sections.map((section) => {
        const opt = document.createElement("option");
        opt.value = section.key;
        opt.textContent = section.label;
        return opt;
      })
    );
  }
  updateNavDisplay(root, sections, currentSectionIndex(root, sections));
}

function deleteControlsFor(task, onDelete) {
  const wrap = document.createElement("div");
  wrap.className = "detail-delete-wrap";

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "detail-delete";
  deleteBtn.textContent = "Delete";
  deleteBtn.disabled = LIVE_RUN_STATUSES.has(task.status);

  const confirmWrap = document.createElement("div");
  confirmWrap.className = "detail-delete-confirm";
  confirmWrap.hidden = true;

  const confirmText = document.createElement("span");
  confirmText.textContent = "Delete this card? This cannot be undone.";

  const confirmYes = document.createElement("button");
  confirmYes.type = "button";
  confirmYes.className = "detail-delete-confirm-yes";
  confirmYes.textContent = "Yes, delete";

  const confirmNo = document.createElement("button");
  confirmNo.type = "button";
  confirmNo.className = "detail-delete-confirm-no";
  confirmNo.textContent = "Cancel";

  deleteBtn.addEventListener("click", () => {
    confirmWrap.hidden = false;
    deleteBtn.hidden = true;
  });
  confirmNo.addEventListener("click", () => {
    confirmWrap.hidden = true;
    deleteBtn.hidden = false;
  });
  confirmYes.addEventListener("click", () => onDelete(task.id));

  confirmWrap.append(confirmText, confirmYes, confirmNo);
  wrap.append(deleteBtn, confirmWrap);
  return wrap;
}

export function renderDetailPanel(
  root,
  task,
  {
    onSave,
    onClose,
    onDelete,
    onAddComment,
    onUploadAttachment,
    onRemoveAttachment,
    agentOptions = [],
    allTasks = [],
    drainState = null
  }
) {
  const previousTaskId = root.dataset.taskId ?? null;
  const isSameTask = task && previousTaskId === String(task.id);
  const focusState = isSameTask ? captureFocusState(root) : null;
  const dirty = isSameTask ? captureDirtyFields(root, root.__lastTask ?? null) : {};

  root.replaceChildren();

  if (!task) {
    delete root.dataset.taskId;
    delete root.__lastTask;
    root.hidden = true;
    return;
  }
  root.dataset.taskId = String(task.id);
  root.hidden = false;

  const panel = document.createElement("div");
  panel.className = "detail-panel";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "detail-close";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => onClose());

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "detail-title";
  titleInput.value = dirty.title !== undefined ? dirty.title : task.title;
  titleInput.dataset.detailField = "title";

  // T-0462 FIX ROUND 2: same reasoning as the composer landmark below -- "top" used to target
  // this input directly, so the very first Alt+ArrowDown of any session (nothing focused yet ->
  // lands on "top") immediately dead-ended every subsequent shortcut, because real focus in a
  // text input correctly suppresses further navigation (criterion 3). The landmark wraps the
  // existing Title <label> without changing what it displays; the input is still reachable and
  // editable by Tab or click exactly as before.
  const topLandmark = document.createElement("div");
  topLandmark.className = "detail-top-landmark";
  topLandmark.tabIndex = -1;
  topLandmark.setAttribute("role", "group");
  topLandmark.setAttribute("aria-label", "Card top");
  topLandmark.appendChild(labeledField("Title", titleInput));

  const prioritySelect = selectFor(PRIORITIES, dirty.priority !== undefined ? dirty.priority : task.priority);
  prioritySelect.className = "detail-priority";

  const statusSelect = selectFor(STATUSES, dirty.status !== undefined ? dirty.status : task.status);
  statusSelect.className = "detail-status";

  const agentSelect = agentSelectFor(agentOptions, dirty.agent !== undefined ? dirty.agent : task.agent);
  agentSelect.className = "detail-agent";

  const phaseInput = document.createElement("input");
  phaseInput.type = "number";
  phaseInput.className = "detail-phase";
  phaseInput.value = dirty.phase !== undefined ? dirty.phase : String(task.phase);
  phaseInput.dataset.detailField = "phase";

  // T-0343: per-card override of MAX_AUTO_RETRY_ATTEMPTS. Empty means "no override" -- the
  // orchestrator's own default applies -- so this never forces a value onto a card that hasn't
  // been given one.
  const maxAttemptsInput = document.createElement("input");
  maxAttemptsInput.type = "number";
  maxAttemptsInput.className = "detail-max-attempts";
  maxAttemptsInput.min = "1";
  maxAttemptsInput.placeholder = String(MAX_AUTO_RETRY_ATTEMPTS);
  maxAttemptsInput.value =
    dirty.maxAttempts !== undefined
      ? dirty.maxAttempts
      : task.max_attempts != null
        ? String(task.max_attempts)
        : "";
  maxAttemptsInput.dataset.detailField = "maxAttempts";

  // T-0368: complexity_points is a human planning signal only -- see
  // test/complexityPointsLaunchIsolation.test.js for the guarantee that nothing in the
  // launch/admission/cost path ever reads it. "No score" (null) is a first-class option, not
  // just an unset default.
  const complexityPointsSelect = complexityPointsSelectFor(
    dirty.complexityPoints !== undefined
      ? dirty.complexityPoints
      : task.complexity_points != null
        ? String(task.complexity_points)
        : NO_SCORE_VALUE
  );
  complexityPointsSelect.className = "detail-complexity-points";
  complexityPointsSelect.dataset.detailField = "complexityPoints";

  const depsEl = document.createElement("div");
  depsEl.className = "detail-deps";
  depsEl.textContent =
    task.depends_on.length > 0 ? `Depends on: ${task.depends_on.join(", ")}` : "No dependencies";

  const depsPicker = createDepsPicker({
    availableTasks: allTasks,
    selectedIds: dirty.dependsOn !== undefined ? dirty.dependsOn : task.depends_on,
    excludeId: task.id
  });
  depsPicker.element.classList.add("detail-deps-edit");

  const branchInfo = branchInfoFor(task);

  const preview = document.createElement("div");
  preview.className = "detail-body-preview";
  preview.innerHTML = renderMarkdown(task.body);

  const bodyTextarea = document.createElement("textarea");
  bodyTextarea.className = "detail-body-edit";
  bodyTextarea.value = dirty.body !== undefined ? dirty.body : task.body;
  bodyTextarea.dataset.detailField = "body";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "detail-save";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => {
    const edited = {
      title: titleInput.value,
      priority: prioritySelect.value,
      status: statusSelect.value,
      body: bodyTextarea.value,
      agent: agentSelect.value === UNASSIGNED_AGENT_VALUE ? null : agentSelect.value,
      phase: Number(phaseInput.value),
      depends_on: depsPicker.getSelected(),
      max_attempts: maxAttemptsInput.value.trim() === "" ? null : Number(maxAttemptsInput.value),
      complexity_points:
        complexityPointsSelect.value === NO_SCORE_VALUE ? null : Number(complexityPointsSelect.value)
    };
    const patch = buildUpdateBody(task, edited);
    if (Object.keys(patch).length > 0) {
      onSave(task.id, patch);
    }
  });

  panel.append(
    detailNavBarFor(root),
    closeBtn,
    topLandmark,
    labeledField("Priority", prioritySelect),
    labeledField("Status", statusSelect),
    labeledField("Agent", agentSelect),
    labeledField("Phase", phaseInput),
    labeledField("Max attempts", maxAttemptsInput),
    labeledField("Complexity points", complexityPointsSelect),
    depsEl,
    labeledField("Depends on (edit)", depsPicker.element)
  );

  if (branchInfo) {
    panel.appendChild(branchInfo);
  }

  const attemptsInfo = attemptsInfoFor(task);
  if (attemptsInfo) {
    panel.appendChild(attemptsInfo);
  }

  const drainInfo = drainInfoFor(drainState);
  if (drainInfo) {
    panel.appendChild(drainInfo);
  }

  if (onAddComment) {
    panel.appendChild(commentsSectionFor(task, onAddComment));
  }

  if (onUploadAttachment) {
    panel.appendChild(attachmentsSectionFor(task, onUploadAttachment, onRemoveAttachment));
  }

  panel.append(preview, labeledField("Body (markdown)", bodyTextarea), saveBtn, deleteControlsFor(task, onDelete));

  root.appendChild(panel);

  if (typeof dirty.comment === "string") {
    const commentEl = root.querySelector(".detail-comment-input");
    if (commentEl) commentEl.value = dirty.comment;
  }
  if (dirty.deleteConfirmOpen) {
    const confirmEl = root.querySelector(".detail-delete-confirm");
    const deleteEl = root.querySelector(".detail-delete");
    if (confirmEl && deleteEl) {
      confirmEl.hidden = false;
      deleteEl.hidden = true;
    }
  }

  restoreFocusState(root, focusState);
  populateNavBar(root);
  root.__lastTask = task;
}
