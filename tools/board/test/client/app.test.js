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
  const fetchTasksImpl = overrides.fetchTasksImpl ?? vi.fn().mockResolvedValue([]);
  const patchTaskImpl = overrides.patchTaskImpl ?? vi.fn();
  const connectSocketImpl = overrides.connectSocketImpl ?? vi.fn();
  const app = createApp({ boardRoot, fetchTasksImpl, patchTaskImpl, connectSocketImpl });
  return { app, boardRoot, fetchTasksImpl, patchTaskImpl, connectSocketImpl };
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
