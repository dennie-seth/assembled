import { renderMarkdown } from "./markdown.js";
import { buildUpdateBody } from "./detail.js";
import { STATUSES } from "./board.js";

const PRIORITIES = ["P0", "P1", "P2", "P3"];

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

export function renderDetailPanel(root, task, { onSave, onClose }) {
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

  const depsEl = document.createElement("div");
  depsEl.className = "detail-deps";
  depsEl.textContent =
    task.depends_on.length > 0 ? `Depends on: ${task.depends_on.join(", ")}` : "No dependencies";

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
      body: bodyTextarea.value
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
    depsEl,
    preview,
    labeledField("Body (markdown)", bodyTextarea),
    saveBtn
  );

  root.appendChild(panel);
}
