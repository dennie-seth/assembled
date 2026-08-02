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
  const fetchTasksImpl = overrides.fetchTasksImpl ?? vi.fn().mockResolvedValue([]);
  const fetchAgentsImpl = overrides.fetchAgentsImpl ?? vi.fn().mockResolvedValue(["infra", "server"]);
  const patchTaskImpl = overrides.patchTaskImpl ?? vi.fn();
  const connectSocketImpl = overrides.connectSocketImpl ?? vi.fn();
  const runTaskImpl = overrides.runTaskImpl ?? vi.fn().mockResolvedValue({});
  const cancelTaskImpl = overrides.cancelTaskImpl ?? vi.fn().mockResolvedValue({});
  const createTaskImpl = overrides.createTaskImpl ?? vi.fn();
  const deleteTaskImpl = overrides.deleteTaskImpl ?? vi.fn();
  const app = createApp({
    boardRoot,
    detailRoot,
    consoleRoot,
    createFormRoot,
    fetchTasksImpl,
    fetchAgentsImpl,
    patchTaskImpl,
    connectSocketImpl,
    runTaskImpl,
    cancelTaskImpl,
    createTaskImpl,
    deleteTaskImpl
  });
  return {
    app,
    boardRoot,
    detailRoot,
    consoleRoot,
    createFormRoot,
    fetchTasksImpl,
    fetchAgentsImpl,
    patchTaskImpl,
    connectSocketImpl,
    runTaskImpl,
    cancelTaskImpl,
    createTaskImpl,
    deleteTaskImpl
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
      event: { type: "system", subtype: "init" }
    });

    expect(consoleRoot.textContent).toContain("system: init");
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

    app.handleSocketMessage({ type: "run-event", id: "T-0001", phase: "implementer", event: { type: "system", subtype: "init" } });
    app.handleSocketMessage({ type: "run-event", id: "T-0001", phase: "implementer", event: { type: "result", result: "Done." } });

    const lines = consoleRoot.querySelectorAll(".console-line");
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain("init");
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

  it("closes the form without creating anything on handleCancelCreate", async () => {
    const { app, createFormRoot, createTaskImpl } = makeApp();
    await app.init();
    app.handleToggleCreateForm();

    app.handleCancelCreate();

    expect(createFormRoot.hidden).toBe(true);
    expect(createTaskImpl).not.toHaveBeenCalled();
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
