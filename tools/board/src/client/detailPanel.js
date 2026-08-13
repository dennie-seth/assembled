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
  const info = document.createElement("div");
  info.className = "detail-attempts";
  info.textContent = `Auto-retry: run ${task.attempts} of ${MAX_AUTO_RETRY_ATTEMPTS}`;
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

  wrap.append(input, addBtn);
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
    allTasks = []
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
      depends_on: depsPicker.getSelected()
    };
    const patch = buildUpdateBody(task, edited);
    if (Object.keys(patch).length > 0) {
      onSave(task.id, patch);
    }
  });

  panel.append(
    closeBtn,
    labeledField("Title", titleInput),
    labeledField("Priority", prioritySelect),
    labeledField("Status", statusSelect),
    labeledField("Agent", agentSelect),
    labeledField("Phase", phaseInput),
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

  if (onAddComment) {
    panel.appendChild(commentsSectionFor(task, onAddComment));
  }

  if (onUploadAttachment) {
    panel.appendChild(attachmentsSectionFor(task, onUploadAttachment, onRemoveAttachment));
  }

  panel.append(preview, labeledField("Body (markdown)", bodyTextarea), saveBtn, deleteControlsFor(task, onDelete));

  root.appendChild(panel);
  restoreFocusState(root, focusState);
  root.__lastTask = task;
}
