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

  function render() {
    renderBoard(boardRoot, tasks, { onDrop: handleDrop, onCardClick: handleCardClick });
    if (detailRoot) {
      const selected = tasks.find((task) => task.id === selectedId) ?? null;
      renderDetailPanel(detailRoot, selected, { onSave: handleSave, onClose: handleClose });
    }
  }

  async function applyPatch(taskId, patch) {
    const updated = await patchTaskImpl(taskId, patch);
    tasks = tasks.map((task) => (task.id === updated.id ? updated : task));
    render();
  }

  function handleDrop(taskId, newStatus) {
    return applyPatch(taskId, buildStatusPatch(newStatus));
  }

  function handleCardClick(taskId) {
    selectedId = taskId;
    render();
  }

  function handleClose() {
    selectedId = null;
    render();
  }

  function handleSave(taskId, patch) {
    return applyPatch(taskId, patch);
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
    getSelectedId: () => selectedId
  };
}
