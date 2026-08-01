import { fetchTasks, patchTask, connectBoardSocket } from "./api.js";
import { applyTaskEvent, buildStatusPatch } from "./board.js";
import { renderBoard } from "./boardView.js";
import { renderDetailPanel } from "./detailPanel.js";

export function createApp({
  boardRoot,
  detailRoot,
  fetchTasksImpl = fetchTasks,
  patchTaskImpl = patchTask,
  connectSocketImpl = connectBoardSocket
}) {
  let tasks = [];
  let selectedId = null;
  let error = null;

  function render() {
    renderBoard(boardRoot, tasks, { onDrop: handleDrop, onCardClick: handleCardClick, error });
    if (detailRoot) {
      const selected = tasks.find((task) => task.id === selectedId) ?? null;
      renderDetailPanel(detailRoot, selected, { onSave: handleSave, onClose: handleClose });
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

  function handleSocketMessage(event) {
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
    handleSocketMessage,
    getTasks: () => tasks,
    getSelectedId: () => selectedId,
    getError: () => error
  };
}
