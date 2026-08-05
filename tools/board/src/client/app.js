import {
  fetchTasks,
  fetchAgents,
  patchTask,
  connectBoardSocket,
  runTask,
  cancelTask,
  createTask,
  deleteTask,
  exportBacklog,
  exportDone,
  fetchGitStatus,
  addComment,
  uploadAttachment,
  removeAttachment
} from "./api.js";
import { applyTaskEvent, buildStatusPatch, STATUSES, TASK_EVENT_TYPES } from "./board.js";
import { renderBoard } from "./boardView.js";
import { renderDetailPanel } from "./detailPanel.js";
import { renderConsolePanel } from "./consolePanel.js";
import { renderCreateForm } from "./createForm.js";
import { renderGitStatusBar } from "./gitStatusBar.js";

export function createApp({
  boardRoot,
  detailRoot,
  consoleRoot,
  createFormRoot,
  sidePanelRoot,
  gitStatusRoot = null,
  fetchTasksImpl = fetchTasks,
  fetchAgentsImpl = fetchAgents,
  patchTaskImpl = patchTask,
  connectSocketImpl = connectBoardSocket,
  runTaskImpl = runTask,
  cancelTaskImpl = cancelTask,
  createTaskImpl = createTask,
  deleteTaskImpl = deleteTask,
  exportBacklogImpl = exportBacklog,
  exportDoneImpl = exportDone,
  fetchGitStatusImpl = fetchGitStatus,
  addCommentImpl = addComment,
  uploadAttachmentImpl = uploadAttachment,
  removeAttachmentImpl = removeAttachment,
  gitPollIntervalMs = 30000
}) {
  let tasks = [];
  let agentOptions = [];
  let selectedId = null;
  let error = null;
  let createFormOpen = false;
  let createError = null;
  const runLogs = new Map();
  const columnSort = new Map(STATUSES.map((status) => [status, "id"]));
  let gitStatus = null;
  let knownGitHead = null;

  function render() {
    renderBoard(boardRoot, tasks, {
      onDrop: handleDrop,
      onCardClick: handleCardClick,
      onRun: handleRun,
      onCancel: handleCancel,
      onExportBacklog: handleExportBacklog,
      onExportDone: handleExportDone,
      error,
      columnSort,
      onSortChange: handleSortChange
    });
    const selected = selectedId !== null ? (tasks.find((task) => task.id === selectedId) ?? null) : null;
    if (sidePanelRoot) {
      sidePanelRoot.hidden = selected === null;
    }
    if (detailRoot) {
      renderDetailPanel(detailRoot, selected, {
        onSave: handleSave,
        onClose: handleClose,
        onDelete: handleDelete,
        onAddComment: handleAddComment,
        onUploadAttachment: handleUploadAttachment,
        onRemoveAttachment: handleRemoveAttachment,
        agentOptions,
        allTasks: tasks.map((task) => ({ id: task.id, title: task.title }))
      });
    }
    if (consoleRoot) {
      renderConsolePanel(consoleRoot, {
        taskId: selected ? selectedId : null,
        entries: selected ? (runLogs.get(selectedId) ?? []) : []
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
    if (gitStatusRoot) {
      renderGitStatusBar(gitStatusRoot, gitStatus);
    }
  }

  async function applyPatch(taskId, patch) {
    const updated = await patchTaskImpl(taskId, patch);
    tasks = tasks.map((task) => (task.id === updated.id ? updated : task));
    error = null;
    render();
  }

  // A card in `review` or `blocked` moving to `in-progress` (dragged there, or via the
  // detail panel's status dropdown) means "continue and fix this", not "relabel it" --
  // route it through the same /run call the Run/Re-run button uses (Feature B, extended
  // to blocked cards: gitOps.addWorktree reuses the existing branch instead of wiping it)
  // rather than a plain PATCH.
  function isRerunTrigger(taskId, patch) {
    if (patch.status !== "in-progress") return false;
    const current = tasks.find((task) => task.id === taskId);
    return Boolean(current && (current.status === "review" || current.status === "blocked"));
  }

  async function handleDrop(taskId, newStatus) {
    if (isRerunTrigger(taskId, { status: newStatus })) {
      return handleRun(taskId);
    }
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
    if (isRerunTrigger(taskId, patch)) {
      return handleRun(taskId);
    }
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

  function handleExportBacklog() {
    exportBacklogImpl();
  }

  function handleExportDone() {
    exportDoneImpl();
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

  async function handleAddComment(taskId, text) {
    try {
      const updated = await addCommentImpl(taskId, text);
      tasks = tasks.map((task) => (task.id === updated.id ? updated : task));
      error = null;
    } catch (err) {
      error = err.message;
    }
    render();
  }

  async function handleUploadAttachment(taskId, file, uploadedBy) {
    try {
      const updated = await uploadAttachmentImpl(taskId, file, uploadedBy);
      tasks = tasks.map((task) => (task.id === updated.id ? updated : task));
      error = null;
    } catch (err) {
      error = err.message;
    }
    render();
  }

  async function handleRemoveAttachment(taskId, filename) {
    try {
      const updated = await removeAttachmentImpl(taskId, filename);
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

  async function pollGitStatus() {
    if (!fetchGitStatusImpl) return;
    try {
      const info = await fetchGitStatusImpl();
      const updated = knownGitHead !== null && info.head !== knownGitHead;
      gitStatus = { ...info, updated, onReload: () => window.location.reload() };
      render();
    } catch {
      // Non-fatal: git status is informational; don't surface fetch errors on the board.
    }
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

    if (fetchGitStatusImpl) {
      const info = await fetchGitStatusImpl().catch(() => null);
      if (info) {
        knownGitHead = info.head;
        gitStatus = { ...info, updated: false, onReload: () => window.location.reload() };
        render();
        if (gitPollIntervalMs > 0) {
          setInterval(pollGitStatus, gitPollIntervalMs);
        }
      }
    }
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
    handleAddComment,
    handleUploadAttachment,
    handleRemoveAttachment,
    handleSortChange,
    handleToggleCreateForm,
    handleCancelCreate,
    handleCreateSubmit,
    handleSocketMessage,
    handleExportBacklog,
    handleExportDone,
    pollGitStatus,
    getTasks: () => tasks,
    getSelectedId: () => selectedId,
    getError: () => error
  };
}
