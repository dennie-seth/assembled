import { createDepsPicker } from "./depsPicker.js";

const PRIORITIES = ["P0", "P1", "P2", "P3"];
const UNASSIGNED_AGENT_VALUE = "";

function labeledField(labelText, input) {
  const wrapper = document.createElement("label");
  wrapper.className = "detail-field";
  const label = document.createElement("span");
  label.textContent = labelText;
  wrapper.append(label, input);
  return wrapper;
}

function agentSelectFor(agentOptions) {
  const select = document.createElement("select");
  const unassigned = document.createElement("option");
  unassigned.value = UNASSIGNED_AGENT_VALUE;
  unassigned.textContent = "Unassigned";
  select.appendChild(unassigned);
  for (const name of agentOptions) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  return select;
}

function prioritySelectFor() {
  const select = document.createElement("select");
  for (const value of PRIORITIES) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  }
  select.value = "P2";
  return select;
}

export function renderCreateForm(
  root,
  { visible, agentOptions = [], availableTasks = [], onCreate, onCancel, error = null }
) {
  if (!visible) {
    root.replaceChildren();
    root.hidden = true;
    return;
  }

  // Board refresh events (socket task updates, unrelated to this form) call
  // through here too - rebuilding from scratch on every one of those would
  // wipe whatever the user was typing or had picked as a dependency. Only a
  // hidden -> visible transition (a fresh open) gets a clean slate; an
  // already-open form just gets its error message patched in place.
  const alreadyOpen = !root.hidden && root.querySelector(".create-form") !== null;
  if (alreadyOpen) {
    const errorEl = root.querySelector(".create-error");
    if (errorEl) {
      errorEl.textContent = error ?? "";
    }
    return;
  }

  root.replaceChildren();
  root.hidden = false;

  const form = document.createElement("div");
  form.className = "create-form";

  const errorEl = document.createElement("div");
  errorEl.className = "create-error";
  errorEl.textContent = error ?? "";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "create-title";

  const phaseInput = document.createElement("input");
  phaseInput.type = "number";
  phaseInput.className = "create-phase";

  const agentSelect = agentSelectFor(agentOptions);
  agentSelect.className = "create-agent";

  const prioritySelect = prioritySelectFor();
  prioritySelect.className = "create-priority";

  const depsPicker = createDepsPicker({ availableTasks });
  depsPicker.element.classList.add("create-deps");

  const bodyTextarea = document.createElement("textarea");
  bodyTextarea.className = "create-body";

  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "create-submit";
  submitBtn.textContent = "Create";
  submitBtn.addEventListener("click", () => {
    const title = titleInput.value.trim();
    if (title.length === 0) {
      errorEl.textContent = "title is required and must be a non-empty string";
      return;
    }
    const phase = Number(phaseInput.value);
    if (phaseInput.value.trim().length === 0 || !Number.isInteger(phase)) {
      errorEl.textContent = "phase is required and must be an integer";
      return;
    }
    errorEl.textContent = "";
    onCreate({
      title,
      phase,
      agent: agentSelect.value === UNASSIGNED_AGENT_VALUE ? null : agentSelect.value,
      priority: prioritySelect.value,
      depends_on: depsPicker.getSelected(),
      body: bodyTextarea.value
    });
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "create-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => onCancel());

  form.append(
    errorEl,
    labeledField("Title", titleInput),
    labeledField("Phase", phaseInput),
    labeledField("Agent", agentSelect),
    labeledField("Priority", prioritySelect),
    labeledField("Depends on", depsPicker.element),
    labeledField("Body (markdown)", bodyTextarea),
    submitBtn,
    cancelBtn
  );

  root.appendChild(form);
}
