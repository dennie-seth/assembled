import { STATUSES, groupTasksByStatus } from "./board.js";

const STATUS_LABELS = {
  backlog: "Backlog",
  ready: "Ready",
  "in-progress": "In Progress",
  review: "Review",
  done: "Done",
  blocked: "Blocked"
};

function renderCard(task, { onCardClick }) {
  const card = document.createElement("div");
  card.className = "card";
  card.draggable = true;
  card.dataset.id = task.id;

  card.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/plain", task.id);
  });
  card.addEventListener("click", () => onCardClick(task.id));

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = task.title;

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.textContent = `${task.id} · ${task.priority} · ${task.agent ?? "unassigned"} · phase ${task.phase}`;

  card.append(title, meta);
  return card;
}

function renderColumn(status, tasks, callbacks) {
  const column = document.createElement("div");
  column.className = "column";
  column.dataset.status = status;

  const header = document.createElement("h2");
  header.className = "column-header";
  header.textContent = `${STATUS_LABELS[status] ?? status} (${tasks.length})`;
  column.appendChild(header);

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

  for (const task of tasks) {
    list.appendChild(renderCard(task, callbacks));
  }

  column.appendChild(list);
  return column;
}

export function renderBoard(root, tasks, callbacks) {
  const grouped = groupTasksByStatus(tasks);
  root.replaceChildren();

  const board = document.createElement("div");
  board.className = "board";

  for (const status of STATUSES) {
    board.appendChild(renderColumn(status, grouped.get(status) ?? [], callbacks));
  }

  root.appendChild(board);
}
