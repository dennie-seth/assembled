import { fetchTasks, patchTask, connectBoardSocket } from "./api.js";
import { applyTaskEvent, buildStatusPatch } from "./board.js";
import { renderBoard } from "./boardView.js";

export function createApp({
  boardRoot,
  fetchTasksImpl = fetchTasks,
  patchTaskImpl = patchTask,
  connectSocketImpl = connectBoardSocket
}) {
  let tasks = [];

  function render() {
    renderBoard(boardRoot, tasks, { onDrop: handleDrop, onCardClick: handleCardClick });
  }

  async function handleDrop(taskId, newStatus) {
    const updated = await patchTaskImpl(taskId, buildStatusPatch(newStatus));
    tasks = tasks.map((task) => (task.id === updated.id ? updated : task));
    render();
  }

  function handleCardClick(_taskId) {
    // Card detail view lands in T-0017.
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
    handleSocketMessage,
    getTasks: () => tasks
  };
}
