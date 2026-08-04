import { renderMarkdown } from "./markdown.js";
import { buildUpdateBody } from "./detail.js";
import { STATUSES } from "./board.js";
import { createDepsPicker } from "./depsPicker.js";

const PRIORITIES = ["P0", "P1", "P2", "P3"];
const UNASSIGNED_AGENT_VALUE = "";
const LIVE_RUN_STATUSES = new Set(["in-progress", "validation"]);

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
  { onSave, onClose, onDelete, agentOptions = [], allTasks = [] }
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

  panel.append(preview, labeledField("Body (markdown)", bodyTextarea), saveBtn, deleteControlsFor(task, onDelete));

  root.appendChild(panel);
}
