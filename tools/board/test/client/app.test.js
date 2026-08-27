// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createApp } from "../../src/client/app.js";

function task(overrides = {}) {
  return {
    id: "T-0001",
    title: "Sample",
    status: "backlog",
    priority: "P2",
    phase: 1,
    agent: null,
    depends_on: [],
    created: "2026-07-31",
    body: "",
    ...overrides
  };
}

function makeApp(overrides = {}) {
  const boardRoot = document.createElement("div");
  const detailRoot = document.createElement("div");
  const consoleRoot = document.createElement("div");
  const createFormRoot = document.createElement("div");
  const sidePanelRoot = document.createElement("div");
  const gitStatusRoot = overrides.gitStatusRoot ?? null;
  const fetchTasksImpl = overrides.fetchTasksImpl ?? vi.fn().mockResolvedValue([]);
  const fetchAgentsImpl = overrides.fetchAgentsImpl ?? vi.fn().mockResolvedValue(["infra", "server"]);
  const patchTaskImpl = overrides.patchTaskImpl ?? vi.fn();
  const connectSocketImpl = overrides.connectSocketImpl ?? vi.fn();
  const runTaskImpl = overrides.runTaskImpl ?? vi.fn().mockResolvedValue({});
  const cancelTaskImpl = overrides.cancelTaskImpl ?? vi.fn().mockResolvedValue({});
  const createTaskImpl = overrides.createTaskImpl ?? vi.fn();
  const deleteTaskImpl = overrides.deleteTaskImpl ?? vi.fn();
  const exportBacklogImpl = overrides.exportBacklogImpl ?? vi.fn();
  const exportDoneImpl = overrides.exportDoneImpl ?? vi.fn();
  const fetchGitStatusImpl = overrides.fetchGitStatusImpl ?? null;
  const addCommentImpl = overrides.addCommentImpl ?? vi.fn().mockResolvedValue({});
  const uploadAttachmentImpl = overrides.uploadAttachmentImpl ?? vi.fn().mockResolvedValue({});
  const removeAttachmentImpl = overrides.removeAttachmentImpl ?? vi.fn().mockResolvedValue({});
  const app = createApp({
    boardRoot,
    detailRoot,
    consoleRoot,
    createFormRoot,
    sidePanelRoot,
    gitStatusRoot,
    fetchTasksImpl,
    fetchAgentsImpl,
    patchTaskImpl,
    connectSocketImpl,
    runTaskImpl,
    cancelTaskImpl,
    createTaskImpl,
    deleteTaskImpl,
    exportBacklogImpl,
    exportDoneImpl,
    fetchGitStatusImpl,
    addCommentImpl,
    uploadAttachmentImpl,
    removeAttachmentImpl
  });
  return {
    app,
    boardRoot,
    detailRoot,
    consoleRoot,
    createFormRoot,
    sidePanelRoot,
    gitStatusRoot,
    fetchTasksImpl,
    fetchAgentsImpl,
    patchTaskImpl,
    connectSocketImpl,
    runTaskImpl,
    cancelTaskImpl,
    createTaskImpl,
    deleteTaskImpl,
    exportBacklogImpl,
    exportDoneImpl,
    fetchGitStatusImpl,
    addCommentImpl,
    uploadAttachmentImpl,
    removeAttachmentImpl
  };
}

describe("createApp init", () => {
  it("fetches tasks, renders the board, and subscribes to the socket", async () => {
    const t = task({ id: "T-0001", title: "First" });
    const { app, boardRoot, fetchTasksImpl, connectSocketImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([t])
    });

    await app.init();

    expect(fetchTasksImpl).toHaveBeenCalled();
    expect(boardRoot.textContent).toContain("First");
    expect(connectSocketImpl).toHaveBeenCalledWith(app.handleSocketMessage);
  });
});

describe("createApp handleDrop", () => {
  it("PATCHes the new status and re-renders with the server's response", async () => {
    const original = task({ id: "T-0001", status: "backlog", title: "Move me" });
    const patched = { ...original, status: "in-progress" };
    const { app, boardRoot, patchTaskImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      patchTaskImpl: vi.fn().mockResolvedValue(patched)
    });
    await app.init();

    await app.handleDrop("T-0001", "in-progress");

    expect(patchTaskImpl).toHaveBeenCalledWith("T-0001", { status: "in-progress" });
    expect(app.getTasks()).toEqual([patched]);
    const column = boardRoot.querySelector('.column[data-status="in-progress"]');
    expect(column.textContent).toContain("Move me");
  });
});

describe("createApp handleDrop — review card moved to in-progress re-runs instead of relabeling (Feature B)", () => {
  it("calls runTaskImpl (not patchTaskImpl) when a review card is dropped on in-progress", async () => {
    const original = task({ id: "T-0001", status: "review", title: "Fix the CI failure" });
    const { app, patchTaskImpl, runTaskImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      runTaskImpl: vi.fn().mockResolvedValue(original)
    });
    await app.init();

    await app.handleDrop("T-0001", "in-progress");

    expect(runTaskImpl).toHaveBeenCalledWith("T-0001");
    expect(patchTaskImpl).not.toHaveBeenCalled();
  });

  it("still PATCHes normally when a non-review card is dropped on in-progress", async () => {
    const original = task({ id: "T-0001", status: "backlog", title: "Fresh card" });
    const patched = { ...original, status: "in-progress" };
    const { app, patchTaskImpl, runTaskImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      patchTaskImpl: vi.fn().mockResolvedValue(patched)
    });
    await app.init();

    await app.handleDrop("T-0001", "in-progress");

    expect(patchTaskImpl).toHaveBeenCalledWith("T-0001", { status: "in-progress" });
    expect(runTaskImpl).not.toHaveBeenCalled();
  });

  it("does not trigger a run when a review card is dropped on a status other than in-progress", async () => {
    const original = task({ id: "T-0001", status: "review", title: "Reviewed card" });
    const { app, patchTaskImpl, runTaskImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      patchTaskImpl: vi.fn().mockResolvedValue({ ...original, status: "done" })
    });
    await app.init();

    await app.handleDrop("T-0001", "done");

    expect(patchTaskImpl).toHaveBeenCalledWith("T-0001", { status: "done" });
    expect(runTaskImpl).not.toHaveBeenCalled();
  });
});

describe("createApp handleSave — review card status edited to in-progress re-runs instead of relabeling (Feature B)", () => {
  it("calls runTaskImpl (not patchTaskImpl) when Save sets status: in-progress on a review card", async () => {
    const original = task({ id: "T-0001", status: "review", title: "Fix the CI failure" });
    const { app, patchTaskImpl, runTaskImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      runTaskImpl: vi.fn().mockResolvedValue(original)
    });
    await app.init();

    await app.handleSave("T-0001", { status: "in-progress" });

    expect(runTaskImpl).toHaveBeenCalledWith("T-0001");
    expect(patchTaskImpl).not.toHaveBeenCalled();
  });

  it("still PATCHes normally when Save edits a review card without touching status", async () => {
    const original = task({ id: "T-0001", status: "review", title: "Old title" });
    const patched = { ...original, title: "New title" };
    const { app, patchTaskImpl, runTaskImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      patchTaskImpl: vi.fn().mockResolvedValue(patched)
    });
    await app.init();

    await app.handleSave("T-0001", { title: "New title" });

    expect(patchTaskImpl).toHaveBeenCalledWith("T-0001", { title: "New title" });
    expect(runTaskImpl).not.toHaveBeenCalled();
  });
});

describe("createApp handleDrop — blocked card moved to in-progress re-runs instead of relabeling (mirrors Feature B for review)", () => {
  it("calls runTaskImpl (not patchTaskImpl) when a blocked card is dropped on in-progress", async () => {
    const original = task({ id: "T-0001", status: "blocked", title: "Fix the worktree issue" });
    const { app, patchTaskImpl, runTaskImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      runTaskImpl: vi.fn().mockResolvedValue(original)
    });
    await app.init();

    await app.handleDrop("T-0001", "in-progress");

    expect(runTaskImpl).toHaveBeenCalledWith("T-0001");
    expect(patchTaskImpl).not.toHaveBeenCalled();
  });

  it("does not trigger a run when a blocked card is dropped on a status other than in-progress", async () => {
    const original = task({ id: "T-0001", status: "blocked", title: "Blocked card" });
    const { app, patchTaskImpl, runTaskImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      patchTaskImpl: vi.fn().mockResolvedValue({ ...original, status: "ready" })
    });
    await app.init();

    await app.handleDrop("T-0001", "ready");

    expect(patchTaskImpl).toHaveBeenCalledWith("T-0001", { status: "ready" });
    expect(runTaskImpl).not.toHaveBeenCalled();
  });
});

describe("createApp handleSave — blocked card status edited to in-progress re-runs instead of relabeling (mirrors Feature B for review)", () => {
  it("calls runTaskImpl (not patchTaskImpl) when Save sets status: in-progress on a blocked card", async () => {
    const original = task({ id: "T-0001", status: "blocked", title: "Fix the worktree issue" });
    const { app, patchTaskImpl, runTaskImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      runTaskImpl: vi.fn().mockResolvedValue(original)
    });
    await app.init();

    await app.handleSave("T-0001", { status: "in-progress" });

    expect(runTaskImpl).toHaveBeenCalledWith("T-0001");
    expect(patchTaskImpl).not.toHaveBeenCalled();
  });

  it("still PATCHes normally when Save edits a blocked card without touching status", async () => {
    const original = task({ id: "T-0001", status: "blocked", title: "Old title" });
    const patched = { ...original, title: "New title" };
    const { app, patchTaskImpl, runTaskImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      patchTaskImpl: vi.fn().mockResolvedValue(patched)
    });
    await app.init();

    await app.handleSave("T-0001", { title: "New title" });

    expect(patchTaskImpl).toHaveBeenCalledWith("T-0001", { title: "New title" });
    expect(runTaskImpl).not.toHaveBeenCalled();
  });
});

describe("createApp handleAddComment", () => {
  it("POSTs the comment and merges the returned task into state", async () => {
    const original = task({ id: "T-0001", comments: [] });
    const updated = { ...original, comments: [{ author: "Anonymous", text: "please fix X", timestamp: "t" }] };
    const { app, addCommentImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      addCommentImpl: vi.fn().mockResolvedValue(updated)
    });
    await app.init();

    await app.handleAddComment("T-0001", "please fix X");

    expect(addCommentImpl).toHaveBeenCalledWith("T-0001", "please fix X");
    expect(app.getTasks()).toEqual([updated]);
    expect(app.getError()).toBe(null);
  });

  it("surfaces the server's error without touching task state", async () => {
    const original = task({ id: "T-0001" });
    const { app } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      addCommentImpl: vi.fn().mockRejectedValue(new Error("text is required"))
    });
    await app.init();

    await app.handleAddComment("T-0001", "");

    expect(app.getTasks()).toEqual([original]);
    expect(app.getError()).toBe("text is required");
  });
});

describe("createApp handleUploadAttachment", () => {
  it("uploads the file and merges the returned task into state", async () => {
    const original = task({ id: "T-0001", attachments: [] });
    const file = new File(["hello"], "a.png", { type: "image/png" });
    const updated = { ...original, attachments: [{ filename: "a.png", size: 5, mimetype: "image/png" }] };
    const { app, uploadAttachmentImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      uploadAttachmentImpl: vi.fn().mockResolvedValue(updated)
    });
    await app.init();

    await app.handleUploadAttachment("T-0001", file, "Dennie");

    expect(uploadAttachmentImpl).toHaveBeenCalledWith("T-0001", file, "Dennie");
    expect(app.getTasks()).toEqual([updated]);
    expect(app.getError()).toBe(null);
  });

  it("surfaces the server's error without touching task state", async () => {
    const original = task({ id: "T-0001" });
    const file = new File(["<svg></svg>"], "evil.svg", { type: "image/svg+xml" });
    const { app } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      uploadAttachmentImpl: vi.fn().mockRejectedValue(new Error("Attachment type is not allowed"))
    });
    await app.init();

    await app.handleUploadAttachment("T-0001", file);

    expect(app.getTasks()).toEqual([original]);
    expect(app.getError()).toBe("Attachment type is not allowed");
  });
});

describe("createApp handleRemoveAttachment", () => {
  it("removes the attachment and merges the returned task into state", async () => {
    const original = task({
      id: "T-0001",
      attachments: [{ filename: "a.png", size: 5, mimetype: "image/png" }]
    });
    const updated = { ...original, attachments: [] };
    const { app, removeAttachmentImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      removeAttachmentImpl: vi.fn().mockResolvedValue(updated)
    });
    await app.init();

    await app.handleRemoveAttachment("T-0001", "a.png");

    expect(removeAttachmentImpl).toHaveBeenCalledWith("T-0001", "a.png");
    expect(app.getTasks()).toEqual([updated]);
    expect(app.getError()).toBe(null);
  });

  it("surfaces the server's error without touching task state", async () => {
    const original = task({ id: "T-0001", attachments: [{ filename: "a.png" }] });
    const { app } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      removeAttachmentImpl: vi.fn().mockRejectedValue(new Error('Attachment "a.png" not found on T-0001'))
    });
    await app.init();

    await app.handleRemoveAttachment("T-0001", "a.png");

    expect(app.getTasks()).toEqual([original]);
    expect(app.getError()).toBe('Attachment "a.png" not found on T-0001');
  });
});

describe("createApp render wires attachment handlers into the detail panel", () => {
  it("passes onUploadAttachment/onRemoveAttachment through to renderDetailPanel", async () => {
    const original = task({ id: "T-0001" });
    const { app, detailRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([original]) });
    await app.init();

    app.handleCardClick("T-0001");

    expect(detailRoot.querySelector(".detail-attachments")).not.toBeNull();
  });
});

describe("createApp handleDrop dependency guard", () => {
  it("keeps the task in its original column and surfaces the server's error when the move is rejected", async () => {
    const original = task({ id: "T-0001", status: "backlog", title: "Blocked task" });
    const { app, boardRoot } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      patchTaskImpl: vi
        .fn()
        .mockRejectedValue(
          new Error("Cannot move T-0001 to in-progress: unmet dependencies T-0002")
        )
    });
    await app.init();

    await app.handleDrop("T-0001", "in-progress");

    expect(app.getTasks()).toEqual([original]);
    const backlogColumn = boardRoot.querySelector('.column[data-status="backlog"]');
    expect(backlogColumn.textContent).toContain("Blocked task");
    const inProgressColumn = boardRoot.querySelector('.column[data-status="in-progress"]');
    expect(inProgressColumn.textContent).not.toContain("Blocked task");
    expect(app.getError()).toMatch(/unmet dependencies T-0002/);
    expect(boardRoot.textContent).toContain("unmet dependencies T-0002");
  });

  it("clears a previous error once a subsequent move succeeds", async () => {
    const original = task({ id: "T-0001", status: "backlog", title: "Task" });
    const patched = { ...original, status: "ready" };
    const { app, boardRoot } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      patchTaskImpl: vi
        .fn()
        .mockRejectedValueOnce(new Error("blocked"))
        .mockResolvedValueOnce(patched)
    });
    await app.init();

    await app.handleDrop("T-0001", "in-progress");
    expect(app.getError()).toBe("blocked");

    await app.handleDrop("T-0001", "ready");

    expect(app.getError()).toBe(null);
    expect(boardRoot.textContent).not.toContain("blocked");
  });
});

describe("createApp handleSave dependency guard", () => {
  it("surfaces the server's error and leaves the task unchanged when Save is rejected", async () => {
    const original = task({ id: "T-0001", status: "backlog", title: "Task" });
    const { app, boardRoot } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original]),
      patchTaskImpl: vi.fn().mockRejectedValue(new Error("Dependency cycle detected: T-0001 -> T-0001"))
    });
    await app.init();

    await app.handleSave("T-0001", { status: "in-progress" });

    expect(app.getTasks()).toEqual([original]);
    expect(app.getError()).toMatch(/cycle/i);
    expect(boardRoot.textContent).toContain("cycle");
  });
});

describe("createApp handleSocketMessage", () => {
  it("applies an external change event and re-renders without a page reload", async () => {
    const original = task({ id: "T-0001", title: "Old title" });
    const { app, boardRoot } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([original])
    });
    await app.init();
    expect(boardRoot.textContent).toContain("Old title");

    app.handleSocketMessage({ type: "changed", id: "T-0001", task: { ...original, title: "New title" } });

    expect(boardRoot.textContent).toContain("New title");
    expect(boardRoot.textContent).not.toContain("Old title");
  });

  it("reflects a task added by another client", async () => {
    const { app, boardRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([]) });
    await app.init();

    app.handleSocketMessage({ type: "added", id: "T-0002", task: task({ id: "T-0002", title: "From elsewhere" }) });

    expect(boardRoot.textContent).toContain("From elsewhere");
  });

  it("applies a Run action's status transition immediately from a socket event, without a manual refresh", async () => {
    const original = task({ id: "T-0001", title: "Runnable", status: "ready" });
    const { app, boardRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([original]) });
    await app.init();
    expect(boardRoot.querySelector('.column[data-status="ready"]').textContent).toContain("Runnable");

    app.handleSocketMessage({ type: "changed", id: "T-0001", task: { ...original, status: "in-progress" } });

    const inProgressColumn = boardRoot.querySelector('.column[data-status="in-progress"]');
    expect(inProgressColumn.textContent).toContain("Runnable");
    expect(boardRoot.querySelector('.column[data-status="ready"]').textContent).not.toContain("Runnable");
  });

  it("ignores an unrecognized socket message type (e.g. run-status) instead of corrupting task state", async () => {
    const original = task({ id: "T-0001", title: "Unassigned card", status: "ready" });
    const { app, boardRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([original]) });
    await app.init();

    app.handleSocketMessage({
      type: "run-status",
      id: "T-0001",
      phase: "planning",
      message: "Card is unassigned — invoking planner to expand spec before implementation"
    });

    expect(app.getTasks()).toEqual([original]);
    expect(boardRoot.textContent).toContain("Unassigned card");

    // A legitimate status update afterwards must still render correctly --
    // a prior corrupting message must not leave the board permanently stuck.
    app.handleSocketMessage({ type: "changed", id: "T-0001", task: { ...original, status: "in-progress" } });
    expect(boardRoot.querySelector('.column[data-status="in-progress"]').textContent).toContain("Unassigned card");
  });
});

// DOT-7 (docs/board-invariants.md): a dependency edit on one card must not leave a
// STALE badge on a different, related card. render() rebuilds the whole board from
// the current `tasks` array on every call, recomputing computeBlockerCounts and
// computeDependencyStatus fresh -- these tests pin that down as an explicit,
// cross-card regression rather than relying on it being an incidental side effect
// of the render architecture (T-0096/T-0095 field report, 2026-08-09).
describe("createApp dependency badge propagation across cards", () => {
  it("clears a card's blocker badge when a DIFFERENT card's dependency on it is removed via a socket event", async () => {
    const dependedOn = task({ id: "T-0096", title: "Integration test", status: "ready", depends_on: [] });
    const dependent = task({ id: "T-0095", title: "CAS transfer", status: "ready", depends_on: ["T-0096"] });
    const { app, boardRoot } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([dependedOn, dependent])
    });
    await app.init();

    let badge = boardRoot.querySelector('.card[data-id="T-0096"] .card-blocker-badge');
    expect(badge).not.toBeNull();
    expect(badge.title || badge.getAttribute("aria-label")).toMatch(/blocks 1 task/i);

    // T-0095 (not T-0096) is the one that changes -- it drops T-0096 from its own
    // depends_on. T-0096 itself is untouched by this event.
    app.handleSocketMessage({ type: "changed", id: "T-0095", task: { ...dependent, depends_on: [] } });

    badge = boardRoot.querySelector('.card[data-id="T-0096"] .card-blocker-badge');
    expect(badge).toBeNull();
  });

  it("updates a card's own dependency dot when its depends_on is emptied via a socket event", async () => {
    const dependent = task({ id: "T-0001", title: "A", status: "ready", depends_on: ["T-0002"] });
    const dependedOn = task({ id: "T-0002", title: "B", status: "backlog", depends_on: [] });
    const { app, boardRoot } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([dependent, dependedOn])
    });
    await app.init();

    let card = boardRoot.querySelector('.card[data-id="T-0001"]');
    expect(card.querySelector(".card-blocked-badge")).not.toBeNull();
    expect(card.querySelector(".card-unblocked-badge")).toBeNull();

    app.handleSocketMessage({ type: "changed", id: "T-0001", task: { ...dependent, depends_on: [] } });

    card = boardRoot.querySelector('.card[data-id="T-0001"]');
    expect(card.querySelector(".card-blocked-badge")).toBeNull();
    expect(card.querySelector(".card-unblocked-badge")).not.toBeNull();
  });

  it("clears a card's blocker badge when a dependency is removed via the local Save path (no socket round-trip)", async () => {
    const dependedOn = task({ id: "T-0096", title: "Integration test", status: "ready", depends_on: [] });
    const dependent = task({ id: "T-0095", title: "CAS transfer", status: "ready", depends_on: ["T-0096"] });
    const patchTaskImpl = vi.fn().mockResolvedValue({ ...dependent, depends_on: [] });
    const { app, boardRoot } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([dependedOn, dependent]),
      patchTaskImpl
    });
    await app.init();
    expect(boardRoot.querySelector('.card[data-id="T-0096"] .card-blocker-badge')).not.toBeNull();

    await app.handleSave("T-0095", { depends_on: [] });

    expect(boardRoot.querySelector('.card[data-id="T-0096"] .card-blocker-badge')).toBeNull();
  });
});

describe("createApp stale state when selected task is removed externally", () => {
  it("hides the side panel when the selected task is removed via a socket removed event", async () => {
    const t = task({ id: "T-0001" });
    const { app, sidePanelRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([t]) });
    await app.init();
    app.handleCardClick("T-0001");
    expect(sidePanelRoot.hidden).toBe(false);

    app.handleSocketMessage({ type: "removed", id: "T-0001", task: null });

    expect(sidePanelRoot.hidden).toBe(true);
  });

  it("hides the console panel when the selected task is removed via a socket removed event", async () => {
    const t = task({ id: "T-0001", status: "in-progress" });
    const { app, consoleRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([t]) });
    await app.init();
    app.handleCardClick("T-0001");
    app.handleSocketMessage({
      type: "run-event",
      id: "T-0001",
      phase: "implementer",
      event: { type: "result", result: "done" }
    });
    expect(consoleRoot.hidden).toBe(false);

    app.handleSocketMessage({ type: "removed", id: "T-0001", task: null });

    expect(consoleRoot.hidden).toBe(true);
  });
});

describe("createApp side panel visibility (Done column clipping regression)", () => {
  it("keeps the side panel hidden after init when no card is selected", async () => {
    const t = task({ id: "T-0001" });
    const { app, sidePanelRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([t]) });

    await app.init();

    expect(sidePanelRoot.hidden).toBe(true);
  });

  it("reveals the side panel only once a card is selected, and hides it again on close", async () => {
    const t = task({ id: "T-0001" });
    const { app, sidePanelRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([t]) });
    await app.init();

    app.handleCardClick("T-0001");
    expect(sidePanelRoot.hidden).toBe(false);

    app.handleClose();
    expect(sidePanelRoot.hidden).toBe(true);
  });
});

describe("createApp card detail wiring", () => {
  it("opens the detail panel with the clicked task's fields on handleCardClick", async () => {
    const t = task({ id: "T-0001", title: "Inspect me", body: "## Context\nhi" });
    const { app, detailRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([t]) });
    await app.init();

    app.handleCardClick("T-0001");

    expect(app.getSelectedId()).toBe("T-0001");
    expect(detailRoot.hidden).toBe(false);
    expect(detailRoot.querySelector(".detail-title").value).toBe("Inspect me");
    expect(detailRoot.querySelector(".detail-body-preview").textContent).toContain("hi");
  });

  it("PATCHes only the edited fields on Save and refreshes both board and detail panel", async () => {
    const t = task({ id: "T-0001", title: "Old title", priority: "P2" });
    const patched = { ...t, title: "New title" };
    const { app, boardRoot, detailRoot, patchTaskImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([t]),
      patchTaskImpl: vi.fn().mockResolvedValue(patched)
    });
    await app.init();
    app.handleCardClick("T-0001");

    await app.handleSave("T-0001", { title: "New title" });

    expect(patchTaskImpl).toHaveBeenCalledWith("T-0001", { title: "New title" });
    expect(app.getTasks()).toEqual([patched]);
    expect(boardRoot.textContent).toContain("New title");
    expect(detailRoot.querySelector(".detail-title").value).toBe("New title");
  });

  it("closes and clears the selection on handleClose, hiding the panel cleanly", async () => {
    const t = task({ id: "T-0001" });
    const { app, detailRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([t]) });
    await app.init();
    app.handleCardClick("T-0001");
    expect(detailRoot.hidden).toBe(false);

    app.handleClose();

    expect(app.getSelectedId()).toBe(null);
    expect(detailRoot.hidden).toBe(true);
  });

  it("keeps the detail panel in sync when the selected task changes over the socket", async () => {
    const t = task({ id: "T-0001", title: "Old title" });
    const { app, detailRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([t]) });
    await app.init();
    app.handleCardClick("T-0001");

    app.handleSocketMessage({ type: "changed", id: "T-0001", task: { ...t, title: "Externally renamed" } });

    expect(detailRoot.querySelector(".detail-title").value).toBe("Externally renamed");
  });

  it("does not clobber an unsaved dependency selection when a socket 'changed' event arrives for the open card (T-0151)", async () => {
    // Reported live: "when I'm trying to add a dependency and scroll down to save the
    // task, the dependency gets removed before I even have a chance to save it." A card
    // under active agent work re-broadcasts "changed" frequently enough (e.g. its
    // `attempts` counter) to land squarely in that scroll-to-Save window.
    const t = task({ id: "T-0001", depends_on: [] });
    const other = task({ id: "T-0002", title: "Blocked-on candidate" });
    const { app, detailRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([t, other]) });
    await app.init();
    app.handleCardClick("T-0001");

    const depsSelect = detailRoot.querySelector(".detail-deps-edit .deps-picker-select");
    depsSelect.value = "T-0002";
    depsSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(detailRoot.querySelectorAll(".detail-deps-edit .deps-chip").length).toBe(1);

    app.handleSocketMessage({ type: "changed", id: "T-0001", task: { ...t, attempts: 1 } });

    const chips = detailRoot.querySelectorAll(".detail-deps-edit .deps-chip");
    expect(chips.length).toBe(1);
    expect(chips[0].dataset.id).toBe("T-0002");
  });

  it("does not clobber an unsaved dependency selection when a socket 'added' event arrives for a different card", async () => {
    const t = task({ id: "T-0001", depends_on: [] });
    const other = task({ id: "T-0002", title: "Blocked-on candidate" });
    const { app, detailRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([t, other]) });
    await app.init();
    app.handleCardClick("T-0001");

    const depsSelect = detailRoot.querySelector(".detail-deps-edit .deps-picker-select");
    depsSelect.value = "T-0002";
    depsSelect.dispatchEvent(new Event("change", { bubbles: true }));

    app.handleSocketMessage({ type: "added", id: "T-0003", task: task({ id: "T-0003", title: "New card" }) });

    const chips = detailRoot.querySelectorAll(".detail-deps-edit .deps-chip");
    expect(chips.length).toBe(1);
    expect(chips[0].dataset.id).toBe("T-0002");
  });
});

describe("createApp Run / Cancel wiring", () => {
  it("handleRun POSTs /run and clears any prior error on success", async () => {
    const t = task({ id: "T-0001", status: "ready" });
    const { app, runTaskImpl } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([t]) });
    await app.init();

    await app.handleRun("T-0001");

    expect(runTaskImpl).toHaveBeenCalledWith("T-0001");
    expect(app.getError()).toBe(null);
  });

  it("handleRun surfaces the server's error without touching task state", async () => {
    const t = task({ id: "T-0001", status: "ready" });
    const { app } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([t]),
      runTaskImpl: vi.fn().mockRejectedValue(new Error("Task T-0001 already has an active run"))
    });
    await app.init();

    await app.handleRun("T-0001");

    expect(app.getError()).toMatch(/already has an active run/);
    expect(app.getTasks()).toEqual([t]);
  });

  it("handleCancel POSTs /cancel and applies the resulting task state", async () => {
    const t = task({ id: "T-0001", status: "in-progress" });
    const cancelled = { ...t, status: "blocked" };
    const { app, boardRoot, cancelTaskImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([t]),
      cancelTaskImpl: vi.fn().mockResolvedValue(cancelled)
    });
    await app.init();

    await app.handleCancel("T-0001");

    expect(cancelTaskImpl).toHaveBeenCalledWith("T-0001");
    expect(app.getTasks()).toEqual([cancelled]);
    const blockedColumn = boardRoot.querySelector('.column[data-status="blocked"]');
    expect(blockedColumn.textContent).toContain(t.title);
  });

  it("handleCancel surfaces the server's error", async () => {
    const t = task({ id: "T-0001", status: "in-progress" });
    const { app } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([t]),
      cancelTaskImpl: vi.fn().mockRejectedValue(new Error("No active run for T-0001"))
    });
    await app.init();

    await app.handleCancel("T-0001");

    expect(app.getError()).toMatch(/No active run/);
  });
});

describe("createApp agent console wiring (T-0022)", () => {
  it("appends run-event socket messages to the selected card's console log", async () => {
    const t = task({ id: "T-0001", status: "in-progress" });
    const { app, consoleRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([t]) });
    await app.init();
    app.handleCardClick("T-0001");

    app.handleSocketMessage({
      type: "run-event",
      id: "T-0001",
      phase: "implementer",
      event: { type: "assistant", message: { content: [{ type: "text", text: "Looking at the task." }] } }
    });

    expect(consoleRoot.textContent).toContain("Looking at the task.");
  });

  it("does not treat a run-event message as a task-changed event", async () => {
    const t = task({ id: "T-0001", status: "in-progress" });
    const { app } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([t]) });
    await app.init();

    app.handleSocketMessage({
      type: "run-event",
      id: "T-0001",
      phase: "implementer",
      event: { type: "system", subtype: "init" }
    });

    expect(app.getTasks()).toEqual([t]);
  });

  it("keeps accumulating log entries for a card across multiple events, in order", async () => {
    const t = task({ id: "T-0001", status: "in-progress" });
    const { app, consoleRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([t]) });
    await app.init();
    app.handleCardClick("T-0001");

    app.handleSocketMessage({ type: "run-event", id: "T-0001", phase: "implementer", event: { type: "assistant", message: { content: [{ type: "text", text: "Starting." }] } } });
    app.handleSocketMessage({ type: "run-event", id: "T-0001", phase: "implementer", event: { type: "result", result: "Done." } });

    const lines = consoleRoot.querySelectorAll(".console-line");
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain("Starting.");
    expect(lines[1].textContent).toContain("Done.");
  });

  it("shows no console panel for a card until it is selected, even if events arrive", async () => {
    const t = task({ id: "T-0001", status: "in-progress" });
    const { app, consoleRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([t]) });
    await app.init();

    app.handleSocketMessage({ type: "run-event", id: "T-0001", phase: "implementer", event: { type: "system", subtype: "init" } });

    expect(consoleRoot.hidden).toBe(true);
  });
});

describe("createApp create-card wiring", () => {
  it("fetches the agent catalog on init", async () => {
    const { app, fetchAgentsImpl } = makeApp();
    await app.init();
    expect(fetchAgentsImpl).toHaveBeenCalled();
  });

  it("keeps the create form hidden until toggled open", async () => {
    const { app, createFormRoot } = makeApp();
    await app.init();
    expect(createFormRoot.hidden).toBe(true);
  });

  it("opens the create form on handleToggleCreateForm and closes it again", async () => {
    const { app, createFormRoot } = makeApp();
    await app.init();

    app.handleToggleCreateForm();
    expect(createFormRoot.hidden).toBe(false);

    app.handleToggleCreateForm();
    expect(createFormRoot.hidden).toBe(true);
  });

  it("creates a task, adds it to the board, and closes the form on success", async () => {
    const created = task({ id: "T-0002", title: "Brand new" });
    const { app, boardRoot, createFormRoot, createTaskImpl } = makeApp({
      createTaskImpl: vi.fn().mockResolvedValue(created)
    });
    await app.init();
    app.handleToggleCreateForm();

    await app.handleCreateSubmit({ title: "Brand new", phase: 1 });

    expect(createTaskImpl).toHaveBeenCalledWith({ title: "Brand new", phase: 1 });
    expect(app.getTasks()).toContainEqual(created);
    expect(boardRoot.textContent).toContain("Brand new");
    expect(createFormRoot.hidden).toBe(true);
  });

  it("surfaces the server's validation error and keeps the form open on failure", async () => {
    const { app, createFormRoot } = makeApp({
      createTaskImpl: vi.fn().mockRejectedValue(new Error("title is required and must be a non-empty string"))
    });
    await app.init();
    app.handleToggleCreateForm();

    await app.handleCreateSubmit({ title: "", phase: 1 });

    expect(app.getError()).toMatch(/title is required/);
    expect(createFormRoot.hidden).toBe(false);
  });

  it("does not duplicate the card when the WS added-echo for the same id arrives before the create POST resolves (race)", async () => {
    const created = task({ id: "T-0002", title: "Brand new" });
    let resolveCreate;
    const createTaskImpl = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        })
    );
    const { app, boardRoot } = makeApp({ createTaskImpl });
    await app.init();
    app.handleToggleCreateForm();

    const submitPromise = app.handleCreateSubmit({ title: "Brand new", phase: 1 });
    // The server broadcasts the "added" event to all clients, including the one that
    // submitted the create -- it can reach this client over the socket before the HTTP
    // POST promise resolves.
    app.handleSocketMessage({ type: "added", id: "T-0002", task: created });
    resolveCreate(created);
    await submitPromise;

    expect(app.getTasks().filter((t) => t.id === "T-0002")).toHaveLength(1);
    expect(boardRoot.querySelectorAll('.card[data-id="T-0002"]')).toHaveLength(1);
  });

  it("does not duplicate the card when the WS added-echo for the same id arrives after the create POST resolves", async () => {
    const created = task({ id: "T-0002", title: "Brand new" });
    const { app, boardRoot } = makeApp({
      createTaskImpl: vi.fn().mockResolvedValue(created)
    });
    await app.init();
    app.handleToggleCreateForm();

    await app.handleCreateSubmit({ title: "Brand new", phase: 1 });
    app.handleSocketMessage({ type: "added", id: "T-0002", task: created });

    expect(app.getTasks().filter((t) => t.id === "T-0002")).toHaveLength(1);
    expect(boardRoot.querySelectorAll('.card[data-id="T-0002"]')).toHaveLength(1);
  });

  it("closes the form without creating anything on handleCancelCreate", async () => {
    const { app, createFormRoot, createTaskImpl } = makeApp();
    await app.init();
    app.handleToggleCreateForm();

    app.handleCancelCreate();

    expect(createFormRoot.hidden).toBe(true);
    expect(createTaskImpl).not.toHaveBeenCalled();
  });

  it("does not wipe in-progress input when a refresh event arrives while the form is open (reset-on-refresh regression)", async () => {
    const other = task({ id: "T-0001", title: "Unrelated task" });
    const { app, createFormRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([other]) });
    await app.init();
    app.handleToggleCreateForm();

    const titleInput = createFormRoot.querySelector(".create-title");
    const bodyTextarea = createFormRoot.querySelector(".create-body");
    titleInput.value = "In-progress title the user is still typing";
    bodyTextarea.value = "## Context\nstill drafting this";

    // A task-list refresh unrelated to the create form (e.g. someone
    // dragging a card, or the tasks/*.md file watcher firing) must not
    // clobber the open form's unsaved input.
    app.handleSocketMessage({ type: "changed", id: "T-0001", task: { ...other, status: "in-progress" } });

    expect(createFormRoot.querySelector(".create-title").value).toBe("In-progress title the user is still typing");
    expect(createFormRoot.querySelector(".create-body").value).toBe("## Context\nstill drafting this");
    expect(createFormRoot.hidden).toBe(false);
  });
});

describe("createApp per-column sort wiring", () => {
  it("re-renders the board with the newly chosen sort key for that column", async () => {
    const t = task({ id: "T-0001" });
    const { app, boardRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([t]) });
    await app.init();

    app.handleSortChange("backlog", "priority");

    const select = boardRoot.querySelector('.column[data-status="backlog"] .column-sort');
    expect(select.value).toBe("priority");
  });

  it("keeps a column's chosen sort key across a socket-triggered refresh", async () => {
    const t = task({ id: "T-0001" });
    const { app, boardRoot } = makeApp({ fetchTasksImpl: vi.fn().mockResolvedValue([t]) });
    await app.init();
    app.handleSortChange("ready", "agent");

    app.handleSocketMessage({ type: "changed", id: "T-0001", task: { ...t, title: "Renamed elsewhere" } });

    const select = boardRoot.querySelector('.column[data-status="ready"] .column-sort');
    expect(select.value).toBe("agent");
  });

  it("keeps each column's sort key independent", async () => {
    const { app, boardRoot } = makeApp();
    await app.init();

    app.handleSortChange("backlog", "phase");
    app.handleSortChange("ready", "agent");

    expect(boardRoot.querySelector('.column[data-status="backlog"] .column-sort').value).toBe("phase");
    expect(boardRoot.querySelector('.column[data-status="ready"] .column-sort').value).toBe("agent");
  });
});

describe("createApp delete-card wiring", () => {
  it("deletes a task, removes it from the board, and closes the detail panel if it was open", async () => {
    const t = task({ id: "T-0001", title: "Doomed", status: "backlog" });
    const { app, boardRoot, detailRoot, deleteTaskImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([t]),
      deleteTaskImpl: vi.fn().mockResolvedValue({ id: "T-0001", deleted: true })
    });
    await app.init();
    app.handleCardClick("T-0001");

    await app.handleDelete("T-0001");

    expect(deleteTaskImpl).toHaveBeenCalledWith("T-0001");
    expect(app.getTasks()).toEqual([]);
    expect(boardRoot.textContent).not.toContain("Doomed");
    expect(app.getSelectedId()).toBe(null);
    expect(detailRoot.hidden).toBe(true);
  });

  it("surfaces the server's error and keeps the task when delete is blocked", async () => {
    const t = task({ id: "T-0001", title: "Running", status: "in-progress" });
    const { app, deleteTaskImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([t]),
      deleteTaskImpl: vi.fn().mockRejectedValue(new Error('Cannot delete T-0001: status is "in-progress" (active run)'))
    });
    await app.init();

    await app.handleDelete("T-0001");

    expect(deleteTaskImpl).toHaveBeenCalledWith("T-0001");
    expect(app.getError()).toMatch(/active run/);
    expect(app.getTasks()).toEqual([t]);
  });
});

describe("createApp backlog export wiring", () => {
  it("calls exportBacklogImpl when handleExportBacklog is invoked", async () => {
    const exportBacklogImpl = vi.fn();
    const { app } = makeApp({ exportBacklogImpl });
    await app.init();

    app.handleExportBacklog();

    expect(exportBacklogImpl).toHaveBeenCalledTimes(1);
  });
});

describe("createApp done export wiring", () => {
  it("calls exportDoneImpl when handleExportDone is invoked", async () => {
    const exportDoneImpl = vi.fn();
    const { app } = makeApp({ exportDoneImpl });
    await app.init();

    app.handleExportDone();

    expect(exportDoneImpl).toHaveBeenCalledTimes(1);
  });
});

describe("createApp git status wiring", () => {
  it("calls fetchGitStatusImpl on init and renders branch in gitStatusRoot", async () => {
    const gitStatusRoot = document.createElement("div");
    const fetchGitStatusImpl = vi.fn().mockResolvedValue({
      branch: "main",
      head: "abc123def456abc123def456abc123def456abc1",
      headTimestamp: "2026-08-04T10:00:00Z"
    });
    const { app } = makeApp({ fetchGitStatusImpl, gitStatusRoot });
    await app.init();
    expect(fetchGitStatusImpl).toHaveBeenCalled();
    expect(gitStatusRoot.textContent).toContain("main");
  });

  it("shows an update banner in gitStatusRoot when pollGitStatus detects a new HEAD", async () => {
    const gitStatusRoot = document.createElement("div");
    let callCount = 0;
    const fetchGitStatusImpl = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ branch: "main", head: "aaa", headTimestamp: "2026-08-04T10:00:00Z" });
      }
      return Promise.resolve({ branch: "main", head: "bbb", headTimestamp: "2026-08-04T11:00:00Z" });
    });
    const { app } = makeApp({ fetchGitStatusImpl, gitStatusRoot });
    await app.init();

    await app.pollGitStatus();

    expect(gitStatusRoot.querySelector(".git-status-updated")).not.toBeNull();
  });

  it("does not show update banner when HEAD is unchanged across polls", async () => {
    const gitStatusRoot = document.createElement("div");
    const fetchGitStatusImpl = vi.fn().mockResolvedValue({
      branch: "main",
      head: "abc123",
      headTimestamp: "2026-08-04T10:00:00Z"
    });
    const { app } = makeApp({ fetchGitStatusImpl, gitStatusRoot });
    await app.init();

    await app.pollGitStatus();

    expect(gitStatusRoot.querySelector(".git-status-updated")).toBeNull();
  });

  it("renders nothing in gitStatusRoot when fetchGitStatusImpl is not provided", async () => {
    const gitStatusRoot = document.createElement("div");
    const { app } = makeApp({ gitStatusRoot });
    await app.init();
    expect(gitStatusRoot.children.length).toBe(0);
  });
});


// ---------------------------------------------------------------------------
// Transient view state survives model-driven re-renders.
//
// Reported live: with cards running, opening a column-sort dropdown and clicking
// an option does nothing -- the dropdown closes before the click lands. Root
// cause is that every websocket event calls render(), which replaces the whole
// DOM, and while agents run those events arrive several times a second. The
// general form is worse than the reported symptom: a `click` only fires on the
// nearest common ancestor of mousedown and mouseup, so a rebuild between them
// means NO click event fires at all, for any button on the page.
// ---------------------------------------------------------------------------

function socketHandlerOf(connectSocketImpl) {
  return connectSocketImpl.mock.calls[0][0];
}

describe("createApp: renders do not clobber a live interaction", () => {
  it("does not rebuild the board while a sort dropdown has focus", async () => {
    const t = task({ id: "T-0001", status: "ready" });
    const { app, boardRoot, connectSocketImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([t])
    });
    document.body.appendChild(boardRoot);
    await app.init();

    const select = boardRoot.querySelector('.column-sort[data-status="ready"]');
    select.focus();

    socketHandlerOf(connectSocketImpl)({
      type: "changed",
      id: "T-0001",
      task: task({ id: "T-0001", status: "ready", title: "renamed" })
    });

    // Same element, still attached, still focused: the open popup survives and the
    // pending click has somewhere to land.
    expect(boardRoot.querySelector('.column-sort[data-status="ready"]')).toBe(select);
    expect(select.isConnected).toBe(true);
    expect(document.activeElement).toBe(select);
    document.body.removeChild(boardRoot);
  });

  it("applies the deferred update once the dropdown is left", async () => {
    const t = task({ id: "T-0001", status: "ready", title: "before" });
    const { app, boardRoot, connectSocketImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([t])
    });
    document.body.appendChild(boardRoot);
    await app.init();

    const select = boardRoot.querySelector('.column-sort[data-status="ready"]');
    select.focus();
    socketHandlerOf(connectSocketImpl)({
      type: "changed",
      id: "T-0001",
      task: task({ id: "T-0001", status: "ready", title: "after" })
    });
    expect(boardRoot.textContent).toContain("before");

    select.blur();
    select.dispatchEvent(new Event("focusout", { bubbles: true }));

    expect(boardRoot.textContent).toContain("after");
    document.body.removeChild(boardRoot);
  });

  it("does not drop a Run click when an event arrives mid-press", async () => {
    const t = task({ id: "T-0001", status: "ready" });
    const { app, boardRoot, connectSocketImpl, runTaskImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([t])
    });
    document.body.appendChild(boardRoot);
    await app.init();

    const runBtn = boardRoot.querySelector('.card[data-id="T-0001"] .card-run');

    runBtn.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    socketHandlerOf(connectSocketImpl)({
      type: "changed",
      id: "T-0001",
      task: task({ id: "T-0001", status: "ready", title: "renamed mid-press" })
    });

    expect(runBtn.isConnected).toBe(true);

    runBtn.dispatchEvent(new Event("pointerup", { bubbles: true }));
    runBtn.dispatchEvent(new Event("click", { bubbles: true }));

    expect(runTaskImpl).toHaveBeenCalledWith("T-0001");
    document.body.removeChild(boardRoot);
  });

  it("restores keyboard focus across a render that does proceed", async () => {
    const t = task({ id: "T-0001", status: "ready" });
    const { app, boardRoot, connectSocketImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([t])
    });
    document.body.appendChild(boardRoot);
    await app.init();

    // A focused button does NOT gate the render (its click has already committed),
    // so this genuinely exercises the capture/restore pass rather than deferral.
    const runBtn = boardRoot.querySelector('.card[data-id="T-0001"] .card-run');
    runBtn.focus();
    expect(document.activeElement).toBe(runBtn);

    socketHandlerOf(connectSocketImpl)({
      type: "added",
      id: "T-0002",
      task: task({ id: "T-0002", status: "backlog" })
    });

    const rebuilt = boardRoot.querySelector('.card[data-id="T-0001"] .card-run');
    expect(rebuilt).not.toBe(runBtn); // the render really did happen
    expect(document.activeElement).toBe(rebuilt); // and focus came back to it
    document.body.removeChild(boardRoot);
  });

  it("preserves the board horizontal scroll position across a render", async () => {
    const { app, boardRoot, connectSocketImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([task({ id: "T-0001", status: "ready" })])
    });
    document.body.appendChild(boardRoot);
    await app.init();

    // `.board` is the horizontal scroller and is rebuilt inside renderBoard, so a
    // user scrolled right to Blocked/Retired was snapped back to Backlog on every
    // websocket event.
    boardRoot.querySelector(".board").scrollLeft = 640;

    socketHandlerOf(connectSocketImpl)({
      type: "added",
      id: "T-0002",
      task: task({ id: "T-0002", status: "backlog" })
    });

    expect(boardRoot.querySelector(".board").scrollLeft).toBe(640);
    document.body.removeChild(boardRoot);
  });
});

describe("createApp: render pressure", () => {
  it("ignores run-events for a card that is not selected", async () => {
    const t = task({ id: "T-0001", status: "ready" });
    const { app, boardRoot, connectSocketImpl } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([t])
    });
    document.body.appendChild(boardRoot);
    await app.init();

    const before = boardRoot.querySelector(".board");

    for (let i = 0; i < 10; i += 1) {
      socketHandlerOf(connectSocketImpl)({
        type: "run-event",
        id: "T-0999",
        phase: "implementer",
        event: { type: "text", text: "noise" }
      });
    }

    // The console only ever shows the selected card, so these renders would have
    // produced an identical screen -- while destroying every live interaction.
    expect(boardRoot.querySelector(".board")).toBe(before);
    document.body.removeChild(boardRoot);
  });

  it("does not re-render when the git status poll returns an unchanged head", async () => {
    const info = { head: "abc1234", branch: "develop", dirty: false, ahead: 0, behind: 0 };
    const gitStatusRoot = document.createElement("div");
    const { app, boardRoot } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([task({ id: "T-0001", status: "ready" })]),
      fetchGitStatusImpl: vi.fn().mockResolvedValue(info),
      gitStatusRoot
    });
    document.body.appendChild(boardRoot);
    await app.init();

    const before = boardRoot.querySelector(".board");
    await app.pollGitStatus();

    expect(boardRoot.querySelector(".board")).toBe(before);
    document.body.removeChild(boardRoot);
  });

  it("still re-renders when the git head actually moves", async () => {
    const gitStatusRoot = document.createElement("div");
    const fetchGitStatusImpl = vi
      .fn()
      .mockResolvedValueOnce({ head: "abc1234", branch: "develop", dirty: false })
      .mockResolvedValueOnce({ head: "def5678", branch: "develop", dirty: false });
    const { app, boardRoot } = makeApp({
      fetchTasksImpl: vi.fn().mockResolvedValue([task({ id: "T-0001", status: "ready" })]),
      fetchGitStatusImpl,
      gitStatusRoot
    });
    document.body.appendChild(boardRoot);
    await app.init();

    const before = boardRoot.querySelector(".board");
    await app.pollGitStatus();

    expect(boardRoot.querySelector(".board")).not.toBe(before);
    document.body.removeChild(boardRoot);
  });
});
