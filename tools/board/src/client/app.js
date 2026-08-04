import {
  fetchTasks,
  fetchAgents,
  patchTask,
  connectBoardSocket,
  runTask,
  cancelTask,
  createTask,
  deleteTask
} from "./api.js";
import { applyTaskEvent, buildStatusPatch, STATUSES, TASK_EVENT_TYPES } from "./board.js";
import { renderBoard } from "./boardView.js";
import { renderDetailPanel } from "./detailPanel.js";
import { renderConsolePanel } from "./consolePanel.js";
import { renderCreateForm } from "./createForm.js";

export function createApp({
  boardRoot,
  detailRoot,
  consoleRoot,
  createFormRoot,
  sidePanelRoot,
  fetchTasksImpl = fetchTasks,
  fetchAgentsImpl = fetchAgents,
  patchTaskImpl = patchTask,
  connectSocketImpl = connectBoardSocket,
  runTaskImpl = runTask,
  cancelTaskImpl = cancelTask,
  createTaskImpl = createTask,
  deleteTaskImpl = deleteTask
}) {
  let tasks = [];
  let agentOptions = [];
  let selectedId = null;
  let error = null;
  let createFormOpen = false;
  let createError = null;
  const runLogs = new Map();
  const columnSort = new Map(STATUSES.map((status) => [status, "id"]));

  function render() {
    renderBoard(boardRoot, tasks, {
      onDrop: handleDrop,
      onCardClick: handleCardClick,
      onRun: handleRun,
      onCancel: handleCancel,
      error,
      columnSort,
      onSortChange: handleSortChange
    });
    if (sidePanelRoot) {
      sidePanelRoot.hidden = selectedId === null;
    }
    if (detailRoot) {
      const selected = tasks.find((task) => task.id === selectedId) ?? null;
      renderDetailPanel(detailRoot, selected, {
        onSave: handleSave,
        onClose: handleClose,
        onDelete: handleDelete,
        agentOptions,
        allTasks: tasks.map((task) => ({ id: task.id, title: task.title }))
      });
    }
    if (consoleRoot) {
      renderConsolePanel(consoleRoot, {
        taskId: selectedId,
        entries: selectedId ? (runLogs.get(selectedId) ?? []) : []
      });
    }
    if (createFormRoot) {
      renderCreateForm(createFormRoot, {
        visible: createFormOpen,
        agentOptions,
        availableTasks: tasks.map((task) => ({ id: task.id, title: task.title })),
        onCreate: handleCreateSubmit,
        onCancel: handleCancelCreate,
        error: createError
      });
    }
  }

  async function applyPatch(taskId, patch) {
    const updated = await patchTaskImpl(taskId, patch);
    tasks = tasks.map((task) => (task.id === updated.id ? updated : task));
    error = null;
    render();
  }

  async function handleDrop(taskId, newStatus) {
    try {
      await applyPatch(taskId, buildStatusPatch(newStatus));
    } catch (err) {
      error = err.message;
      render();
    }
  }

  function handleSortChange(status, sortKey) {
    columnSort.set(status, sortKey);
    render();
  }

  function handleCardClick(taskId) {
    selectedId = taskId;
    render();
  }

  function handleClose() {
    selectedId = null;
    render();
  }

  async function handleSave(taskId, patch) {
    try {
      await applyPatch(taskId, patch);
    } catch (err) {
      error = err.message;
      render();
    }
  }

  async function handleRun(taskId) {
    try {
      await runTaskImpl(taskId);
      error = null;
    } catch (err) {
      error = err.message;
    }
    render();
  }

  function handleToggleCreateForm() {
    createFormOpen = !createFormOpen;
    createError = null;
    render();
  }

  function handleCancelCreate() {
    createFormOpen = false;
    createError = null;
    render();
  }

  async function handleCreateSubmit(payload) {
    try {
      const created = await createTaskImpl(payload);
      tasks = [...tasks, created];
      createFormOpen = false;
      createError = null;
      error = null;
    } catch (err) {
      createError = err.message;
      error = err.message;
    }
    render();
  }

  async function handleDelete(taskId) {
    try {
      await deleteTaskImpl(taskId);
      tasks = tasks.filter((task) => task.id !== taskId);
      if (selectedId === taskId) {
        selectedId = null;
      }
      error = null;
    } catch (err) {
      error = err.message;
    }
    render();
  }

  async function handleCancel(taskId) {
    try {
      const updated = await cancelTaskImpl(taskId);
      tasks = tasks.map((task) => (task.id === updated.id ? updated : task));
      error = null;
    } catch (err) {
      error = err.message;
    }
    render();
  }

  function handleRunEvent(event) {
    const existing = runLogs.get(event.id) ?? [];
    runLogs.set(event.id, [...existing, { phase: event.phase, event: event.event }]);
    render();
  }

  function handleSocketMessage(event) {
    if (event.type === "run-event") {
      handleRunEvent(event);
      return;
    }
    if (!TASK_EVENT_TYPES.has(event.type)) {
      // Unrecognized message types (e.g. a run's phase notices) carry no
      // `task` payload -- applying them here would clobber a real task with
      // `undefined`. Ignore anything that isn't a known task mutation.
      return;
    }
    tasks = applyTaskEvent(tasks, event);
    render();
  }

  async function init() {
    const [fetchedTasks, fetchedAgents] = await Promise.all([
      fetchTasksImpl(),
      fetchAgentsImpl().catch(() => [])
    ]);
    tasks = fetchedTasks;
    agentOptions = fetchedAgents;
    render();
    connectSocketImpl(handleSocketMessage);
  }

  return {
    init,
    render,
    handleDrop,
    handleCardClick,
    handleClose,
    handleSave,
    handleRun,
    handleCancel,
    handleDelete,
    handleSortChange,
    handleToggleCreateForm,
    handleCancelCreate,
    handleCreateSubmit,
    handleSocketMessage,
    getTasks: () => tasks,
    getSelectedId: () => selectedId,
    getError: () => error
  };
}
