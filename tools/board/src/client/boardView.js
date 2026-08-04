import { STATUSES, groupTasksByStatus, computeBlockerCounts, sortTasks, SORT_KEYS } from "./board.js";

const STATUS_LABELS = {
  backlog: "Backlog",
  ready: "Ready",
  "in-progress": "In Progress",
  validation: "Validation",
  review: "Review",
  done: "Done",
  blocked: "Blocked"
};

const SORT_LABELS = {
  id: "ID",
  priority: "Priority",
  agent: "Agent",
  phase: "Phase"
};

function actionButton(className, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function blockerBadgeFor(blockCount) {
  if (!blockCount) return null;
  const badge = document.createElement("span");
  badge.className = "card-blocker-badge";
  const label = `Blocks ${blockCount} task${blockCount === 1 ? "" : "s"}`;
  badge.textContent = "⛔";
  badge.title = label;
  badge.setAttribute("aria-label", label);
  return badge;
}

function renderCard(task, { onCardClick, onRun, onCancel }, blockerCounts) {
  const card = document.createElement("div");
  card.className = "card";
  card.draggable = true;
  card.dataset.id = task.id;

  card.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/plain", task.id);
  });
  card.addEventListener("click", () => onCardClick(task.id));

  const titleRow = document.createElement("div");
  titleRow.className = "card-title-row";

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = task.title;
  titleRow.appendChild(title);

  const badge = blockerBadgeFor(blockerCounts?.get(task.id) ?? 0);
  if (badge) {
    titleRow.appendChild(badge);
  }

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.textContent = `${task.id} · ${task.priority} · ${task.agent ?? "unassigned"} · phase ${task.phase}`;

  card.append(titleRow, meta);

  if (task.status === "ready" && onRun) {
    card.appendChild(actionButton("card-run", "Run", () => onRun(task.id)));
  }
  if ((task.status === "in-progress" || task.status === "validation") && onCancel) {
    card.appendChild(actionButton("card-cancel", "Cancel", () => onCancel(task.id)));
  }

  return card;
}

function sortSelectFor(status, sortKey, onSortChange) {
  const select = document.createElement("select");
  select.className = "column-sort";
  select.dataset.status = status;
  select.setAttribute("aria-label", `Sort ${STATUS_LABELS[status] ?? status} by`);
  for (const key of SORT_KEYS) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = SORT_LABELS[key] ?? key;
    select.appendChild(opt);
  }
  select.value = sortKey;
  select.addEventListener("click", (event) => event.stopPropagation());
  select.addEventListener("change", (event) => {
    event.stopPropagation();
    onSortChange(status, select.value);
  });
  return select;
}

function renderColumn(status, tasks, callbacks, blockerCounts) {
  const column = document.createElement("div");
  column.className = "column";
  column.dataset.status = status;

  const header = document.createElement("h2");
  header.className = "column-header";
  header.textContent = `${STATUS_LABELS[status] ?? status} (${tasks.length})`;
  column.appendChild(header);

  const sortKey = callbacks.columnSort?.get(status) ?? "id";
  column.appendChild(sortSelectFor(status, sortKey, callbacks.onSortChange ?? (() => {})));

  const list = document.createElement("div");
  list.className = "column-cards";
  list.dataset.status = status;

  list.addEventListener("dragover", (event) => {
    event.preventDefault();
  });
  list.addEventListener("drop", (event) => {
    event.preventDefault();
    const taskId = event.dataTransfer.getData("text/plain");
    if (taskId) {
      callbacks.onDrop(taskId, status);
    }
  });

  for (const task of sortTasks(tasks, sortKey)) {
    list.appendChild(renderCard(task, callbacks, blockerCounts));
  }

  column.appendChild(list);
  return column;
}

export function renderBoard(root, tasks, callbacks) {
  const grouped = groupTasksByStatus(tasks);
  const blockerCounts = computeBlockerCounts(tasks);
  root.replaceChildren();

  if (callbacks.error) {
    const banner = document.createElement("div");
    banner.className = "board-error";
    banner.textContent = callbacks.error;
    root.appendChild(banner);
  }

  const board = document.createElement("div");
  board.className = "board";

  for (const status of STATUSES) {
    board.appendChild(renderColumn(status, grouped.get(status) ?? [], callbacks, blockerCounts));
  }

  root.appendChild(board);
}
