import { renderMarkdown } from "./markdown.js";
import { buildUpdateBody } from "./detail.js";
import { STATUSES } from "./board.js";
import { createDepsPicker } from "./depsPicker.js";
import { attachmentDownloadUrl } from "./api.js";

const PRIORITIES = ["P0", "P1", "P2", "P3"];
const UNASSIGNED_AGENT_VALUE = "";
const LIVE_RUN_STATUSES = new Set(["in-progress", "validation"]);

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
  root.replaceChildren();

  if (!task) {
    root.hidden = true;
    return;
  }
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
  titleInput.value = task.title;

  const prioritySelect = selectFor(PRIORITIES, task.priority);
  prioritySelect.className = "detail-priority";

  const statusSelect = selectFor(STATUSES, task.status);
  statusSelect.className = "detail-status";

  const agentSelect = agentSelectFor(agentOptions, task.agent);
  agentSelect.className = "detail-agent";

  const phaseInput = document.createElement("input");
  phaseInput.type = "number";
  phaseInput.className = "detail-phase";
  phaseInput.value = String(task.phase);

  const depsEl = document.createElement("div");
  depsEl.className = "detail-deps";
  depsEl.textContent =
    task.depends_on.length > 0 ? `Depends on: ${task.depends_on.join(", ")}` : "No dependencies";

  const depsPicker = createDepsPicker({
    availableTasks: allTasks,
    selectedIds: task.depends_on,
    excludeId: task.id
  });
  depsPicker.element.classList.add("detail-deps-edit");

  const branchInfo = branchInfoFor(task);

  const preview = document.createElement("div");
  preview.className = "detail-body-preview";
  preview.innerHTML = renderMarkdown(task.body);

  const bodyTextarea = document.createElement("textarea");
  bodyTextarea.className = "detail-body-edit";
  bodyTextarea.value = task.body;

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

  if (onAddComment) {
    panel.appendChild(commentsSectionFor(task, onAddComment));
  }

  if (onUploadAttachment) {
    panel.appendChild(attachmentsSectionFor(task, onUploadAttachment, onRemoveAttachment));
  }

  panel.append(preview, labeledField("Body (markdown)", bodyTextarea), saveBtn, deleteControlsFor(task, onDelete));

  root.appendChild(panel);
}
