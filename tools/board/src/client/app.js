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
import { applyTaskEvent, buildStatusPatch } from "./board.js";
import { renderBoard } from "./boardView.js";
import { renderDetailPanel } from "./detailPanel.js";
import { renderConsolePanel } from "./consolePanel.js";
import { renderCreateForm } from "./createForm.js";

export function createApp({
  boardRoot,
  detailRoot,
  consoleRoot,
  createFormRoot,
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

  function render() {
    renderBoard(boardRoot, tasks, {
      onDrop: handleDrop,
      onCardClick: handleCardClick,
      onRun: handleRun,
      onCancel: handleCancel,
      error
    });
    if (detailRoot) {
      const selected = tasks.find((task) => task.id === selectedId) ?? null;
      renderDetailPanel(detailRoot, selected, {
        onSave: handleSave,
        onClose: handleClose,
        onDelete: handleDelete,
        agentOptions,
        allTaskIds: tasks.map((task) => task.id)
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
        existingTaskIds: tasks.map((task) => task.id),
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
    handleToggleCreateForm,
    handleCancelCreate,
    handleCreateSubmit,
    handleSocketMessage,
    getTasks: () => tasks,
    getSelectedId: () => selectedId,
    getError: () => error
  };
}
