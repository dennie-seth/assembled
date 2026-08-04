function optionLabel(task) {
  return `${task.id} — ${task.title}`;
}

/**
 * A dependency picker: a dropdown of not-yet-selected tasks plus removable
 * chips for the current selection. Selecting a dropdown option adds it as a
 * chip and removes it from the dropdown; removing a chip does the reverse.
 */
export function createDepsPicker({ availableTasks = [], selectedIds = [], excludeId = null } = {}) {
  let selected = [...new Set(selectedIds)].filter((id) => id !== excludeId);

  const element = document.createElement("div");
  element.className = "deps-picker";

  const chipsEl = document.createElement("div");
  chipsEl.className = "deps-picker-chips";

  const select = document.createElement("select");
  select.className = "deps-picker-select";

  function taskLookup(id) {
    return availableTasks.find((task) => task.id === id);
  }

  function renderChips() {
    chipsEl.replaceChildren();
    for (const id of selected) {
      const chip = document.createElement("span");
      chip.className = "deps-chip";
      chip.dataset.id = id;

      const label = document.createElement("span");
      label.className = "deps-chip-label";
      const task = taskLookup(id);
      label.textContent = task ? optionLabel(task) : id;

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "deps-chip-remove";
      removeBtn.textContent = "×";
      removeBtn.setAttribute("aria-label", `Remove dependency ${id}`);
      removeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        selected = selected.filter((sid) => sid !== id);
        renderAll();
      });

      chip.append(label, removeBtn);
      chipsEl.appendChild(chip);
    }
  }

  function renderSelect() {
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Add dependency…";
    select.appendChild(placeholder);
    for (const task of availableTasks) {
      if (task.id === excludeId) continue;
      if (selected.includes(task.id)) continue;
      const opt = document.createElement("option");
      opt.value = task.id;
      opt.textContent = optionLabel(task);
      select.appendChild(opt);
    }
    select.value = "";
  }

  function renderAll() {
    renderChips();
    renderSelect();
  }

  select.addEventListener("change", () => {
    const value = select.value;
    if (!value) return;
    if (!selected.includes(value)) {
      selected = [...selected, value];
    }
    renderAll();
  });

  renderAll();
  element.append(select, chipsEl);

  return {
    element,
    getSelected: () => [...selected]
  };
}
