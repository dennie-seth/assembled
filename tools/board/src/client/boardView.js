import { STATUSES, groupTasksByStatus, computeBlockerCounts, computeDependencyStatus, sortTasks, SORT_KEYS } from "./board.js";

export const BATCH_SIZE = 20;

let _batchObserver = null;

const STATUS_LABELS = {
  backlog: "Backlog",
  ready: "Ready",
  "in-progress": "In Progress",
  validation: "Validation",
  review: "Review",
  done: "Done",
  blocked: "Blocked",
  retired: "Retired"
};

const SORT_LABELS = {
  id: "ID",
  priority: "Priority",
  agent: "Agent",
  phase: "Phase",
  oldest: "Oldest",
  newest: "Newest"
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

// Single derived per-card indicator, driven entirely by computeDependencyStatus so a card
// can never end up rendering both a "blocked" and a "ready" badge at once (see board.js).
function dependencyStatusBadgeFor(status) {
  const isBlocked = status === "blocked";
  const badge = document.createElement("span");
  badge.className = isBlocked ? "card-blocked-badge" : "card-unblocked-badge";
  const label = isBlocked
    ? "Blocked — has unresolved dependencies"
    : "All dependencies complete — ready to run";
  badge.textContent = isBlocked ? "🔴" : "🟢";
  badge.title = label;
  badge.setAttribute("aria-label", label);
  return badge;
}

// Unrelated to the above: this reports downstream impact (other tasks waiting on this one),
// not whether this task's own dependencies are satisfied. Deliberately not red/dot-shaped so
// it can never be mistaken for the blocked/ready pair above.
function blockerBadgeFor(blockCount) {
  if (!blockCount) return null;
  const badge = document.createElement("span");
  badge.className = "card-blocker-badge";
  const label = `Blocks ${blockCount} task${blockCount === 1 ? "" : "s"}`;
  badge.textContent = "🔗";
  badge.title = label;
  badge.setAttribute("aria-label", label);
  return badge;
}

// Mirrors MAX_AUTO_RETRY_ATTEMPTS in src/runner/runOrchestrator.js (server-only module, not
// importable from the client bundle) -- the bounded FAIL -> auto-retry loop's cap.
const MAX_AUTO_RETRY_ATTEMPTS = 5;

function attemptsBadgeFor(task) {
  if (!task.attempts) return null;
  const badge = document.createElement("span");
  badge.className = "card-attempts-badge";
  const label = `Auto-retry: run ${task.attempts} of ${MAX_AUTO_RETRY_ATTEMPTS}`;
  badge.textContent = `↻ ${task.attempts}/${MAX_AUTO_RETRY_ATTEMPTS}`;
  badge.title = label;
  badge.setAttribute("aria-label", label);
  return badge;
}

function renderCard(task, { onCardClick, onRun, onCancel }, blockerCounts, dependencyStatus) {
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

  const depBadge = dependencyStatusBadgeFor(dependencyStatus?.get(task.id));
  titleRow.appendChild(depBadge);

  const attemptsBadge = attemptsBadgeFor(task);
  if (attemptsBadge) {
    titleRow.appendChild(attemptsBadge);
  }

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.textContent = `${task.id} · ${task.priority} · ${task.agent ?? "unassigned"} · phase ${task.phase}`;

  card.append(titleRow, meta);

  if (task.status === "ready" && onRun) {
    card.appendChild(actionButton("card-run", "Run", () => onRun(task.id)));
  }
  if ((task.status === "review" || task.status === "blocked") && onRun) {
    card.appendChild(actionButton("card-rerun", "Re-run", () => onRun(task.id)));
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

function renderColumn(status, tasks, callbacks, blockerCounts, dependencyStatus) {
  const column = document.createElement("div");
  column.className = "column";
  column.dataset.status = status;

  const header = document.createElement("h2");
  header.className = "column-header";
  header.textContent = `${STATUS_LABELS[status] ?? status} (${tasks.length})`;
  column.appendChild(header);

  const sortKey = callbacks.columnSort?.get(status) ?? "id";
  column.appendChild(sortSelectFor(status, sortKey, callbacks.onSortChange ?? (() => {})));

  if (status === "backlog" && callbacks.onExportBacklog) {
    column.appendChild(actionButton("column-export-backlog", "Export", callbacks.onExportBacklog));
  }
  if (status === "done" && callbacks.onExportDone) {
    column.appendChild(actionButton("column-export-done", "Export", callbacks.onExportDone));
  }

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

  const visibleCount = callbacks.columnBatch?.get(status) ?? BATCH_SIZE;
  const sorted = sortTasks(tasks, sortKey);
  for (const task of sorted.slice(0, visibleCount)) {
    list.appendChild(renderCard(task, callbacks, blockerCounts, dependencyStatus));
  }
  if (sorted.length > visibleCount && callbacks.onShowMore) {
    const sentinel = document.createElement("div");
    sentinel.className = "batch-sentinel";
    sentinel.dataset.status = status;
    list.appendChild(sentinel);
  }

  column.appendChild(list);
  return column;
}

export function renderBoard(root, tasks, callbacks) {
  _batchObserver?.disconnect();
  _batchObserver = null;

  const grouped = groupTasksByStatus(tasks);
  const blockerCounts = computeBlockerCounts(tasks);
  const dependencyStatus = computeDependencyStatus(tasks);
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
    board.appendChild(renderColumn(status, grouped.get(status) ?? [], callbacks, blockerCounts, dependencyStatus));
  }

  root.appendChild(board);

  if (callbacks.onShowMore && typeof IntersectionObserver !== "undefined") {
    _batchObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          callbacks.onShowMore(entry.target.dataset.status);
        }
      }
    });
    for (const sentinel of root.querySelectorAll(".batch-sentinel")) {
      _batchObserver.observe(sentinel);
    }
  }
}
