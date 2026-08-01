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
  const fetchTasksImpl = overrides.fetchTasksImpl ?? vi.fn().mockResolvedValue([]);
  const patchTaskImpl = overrides.patchTaskImpl ?? vi.fn();
  const connectSocketImpl = overrides.connectSocketImpl ?? vi.fn();
  const app = createApp({ boardRoot, detailRoot, fetchTasksImpl, patchTaskImpl, connectSocketImpl });
  return { app, boardRoot, detailRoot, fetchTasksImpl, patchTaskImpl, connectSocketImpl };
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
