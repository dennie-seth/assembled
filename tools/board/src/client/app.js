import { fetchTasks, patchTask, connectBoardSocket, runTask, cancelTask } from "./api.js";
import { applyTaskEvent, buildStatusPatch } from "./board.js";
import { renderBoard } from "./boardView.js";
import { renderDetailPanel } from "./detailPanel.js";
import { renderConsolePanel } from "./consolePanel.js";

export function createApp({
  boardRoot,
  detailRoot,
  consoleRoot,
  fetchTasksImpl = fetchTasks,
  patchTaskImpl = patchTask,
  connectSocketImpl = connectBoardSocket,
  runTaskImpl = runTask,
  cancelTaskImpl = cancelTask
}) {
  let tasks = [];
  let selectedId = null;
  let error = null;
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
      renderDetailPanel(detailRoot, selected, { onSave: handleSave, onClose: handleClose });
    }
    if (consoleRoot) {
      renderConsolePanel(consoleRoot, {
        taskId: selectedId,
        entries: selectedId ? (runLogs.get(selectedId) ?? []) : []
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
    tasks = await fetchTasksImpl();
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
    handleSocketMessage,
    getTasks: () => tasks,
    getSelectedId: () => selectedId,
    getError: () => error
  };
}
