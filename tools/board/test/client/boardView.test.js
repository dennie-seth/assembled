// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { renderBoard } from "../../src/client/boardView.js";
import { STATUSES } from "../../src/client/board.js";

function task(overrides = {}) {
  return {
    id: "T-0001",
    title: "Sample task",
    status: "backlog",
    priority: "P1",
    phase: 1,
    agent: "infra",
    depends_on: [],
    created: "2026-07-31",
    body: "",
    ...overrides
  };
}

function dropEvent(taskId) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  event.dataTransfer = { getData: () => taskId };
  return event;
}

describe("renderBoard", () => {
  it("renders one column per known status, in order", () => {
    const root = document.createElement("div");
    renderBoard(root, [], { onDrop: vi.fn(), onCardClick: vi.fn() });

    const columns = root.querySelectorAll(".column");
    expect(columns.length).toBe(STATUSES.length);
    expect([...columns].map((c) => c.dataset.status)).toEqual(STATUSES);
  });

  it("renders a card in its status column with id, title, priority, agent and phase", () => {
    const root = document.createElement("div");
    const t = task({ id: "T-0002", status: "review", title: "Do the thing", priority: "P0", agent: "server", phase: 2 });
    renderBoard(root, [t], { onDrop: vi.fn(), onCardClick: vi.fn() });

    const column = root.querySelector('.column[data-status="review"]');
    const card = column.querySelector(".card");
    expect(card).not.toBeNull();
    expect(card.dataset.id).toBe("T-0002");
    expect(card.textContent).toContain("Do the thing");
    expect(card.textContent).toContain("T-0002");
    expect(card.textContent).toContain("P0");
    expect(card.textContent).toContain("server");
    expect(card.textContent).toContain("2");
  });

  it("clears previously rendered content on re-render", () => {
    const root = document.createElement("div");
    renderBoard(root, [task({ id: "T-0001" })], { onDrop: vi.fn(), onCardClick: vi.fn() });
    renderBoard(root, [], { onDrop: vi.fn(), onCardClick: vi.fn() });
    expect(root.querySelectorAll(".card").length).toBe(0);
  });

  it("invokes onCardClick with the task id when a card is clicked", () => {
    const root = document.createElement("div");
    const onCardClick = vi.fn();
    renderBoard(root, [task({ id: "T-0003" })], { onDrop: vi.fn(), onCardClick });

    root.querySelector('.card[data-id="T-0003"]').dispatchEvent(new Event("click", { bubbles: true }));
    expect(onCardClick).toHaveBeenCalledWith("T-0003");
  });

  it("sets the dragged task id as the drag payload on dragstart", () => {
    const root = document.createElement("div");
    renderBoard(root, [task({ id: "T-0004" })], { onDrop: vi.fn(), onCardClick: vi.fn() });

    const setData = vi.fn();
    const card = root.querySelector('.card[data-id="T-0004"]');
    const dragstart = new Event("dragstart", { bubbles: true });
    dragstart.dataTransfer = { setData };
    card.dispatchEvent(dragstart);

    expect(setData).toHaveBeenCalledWith("text/plain", "T-0004");
  });

  it("calls onDrop with the dragged task id and the target column's status", () => {
    const root = document.createElement("div");
    const onDrop = vi.fn();
    renderBoard(root, [task({ id: "T-0005", status: "backlog" })], { onDrop, onCardClick: vi.fn() });

    const targetColumn = root.querySelector('.column-cards[data-status="in-progress"]');
    targetColumn.dispatchEvent(dropEvent("T-0005"));

    expect(onDrop).toHaveBeenCalledWith("T-0005", "in-progress");
  });

  it("does not call onDrop when the drop payload is empty", () => {
    const root = document.createElement("div");
    const onDrop = vi.fn();
    renderBoard(root, [], { onDrop, onCardClick: vi.fn() });

    const targetColumn = root.querySelector('.column-cards[data-status="done"]');
    targetColumn.dispatchEvent(dropEvent(""));

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("shows a Run control on a ready card and invokes onRun without triggering onCardClick", () => {
    const root = document.createElement("div");
    const onRun = vi.fn();
    const onCardClick = vi.fn();
    renderBoard(root, [task({ id: "T-0006", status: "ready" })], { onDrop: vi.fn(), onCardClick, onRun });

    const runBtn = root.querySelector('.card[data-id="T-0006"] .card-run');
    expect(runBtn).not.toBeNull();
    runBtn.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));

    expect(onRun).toHaveBeenCalledWith("T-0006");
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("does not show a Run control on a card that isn't ready", () => {
    const root = document.createElement("div");
    renderBoard(root, [task({ id: "T-0007", status: "backlog" })], { onDrop: vi.fn(), onCardClick: vi.fn(), onRun: vi.fn() });

    expect(root.querySelector('.card[data-id="T-0007"] .card-run')).toBeNull();
  });

  it("shows a Cancel control on in-progress and validation cards and invokes onCancel", () => {
    const root = document.createElement("div");
    const onCancel = vi.fn();
    renderBoard(
      root,
      [task({ id: "T-0008", status: "in-progress" }), task({ id: "T-0009", status: "validation" })],
      { onDrop: vi.fn(), onCardClick: vi.fn(), onCancel }
    );

    const cancelBtn = root.querySelector('.card[data-id="T-0008"] .card-cancel');
    expect(cancelBtn).not.toBeNull();
    expect(root.querySelector('.card[data-id="T-0009"] .card-cancel')).not.toBeNull();

    cancelBtn.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
    expect(onCancel).toHaveBeenCalledWith("T-0008");
  });

  it("does not show a Cancel control on a ready or review card", () => {
    const root = document.createElement("div");
    renderBoard(root, [task({ id: "T-0010", status: "ready" }), task({ id: "T-0011", status: "review" })], {
      onDrop: vi.fn(),
      onCardClick: vi.fn(),
      onCancel: vi.fn()
    });

    expect(root.querySelector('.card[data-id="T-0010"] .card-cancel')).toBeNull();
    expect(root.querySelector('.card[data-id="T-0011"] .card-cancel')).toBeNull();
  });

  it("renders an error banner when an error message is provided", () => {
    const root = document.createElement("div");
    renderBoard(root, [], { onDrop: vi.fn(), onCardClick: vi.fn(), error: "unmet dependencies T-0002" });

    const banner = root.querySelector(".board-error");
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain("unmet dependencies T-0002");
  });

  it("renders no error banner when there is no error", () => {
    const root = document.createElement("div");
    renderBoard(root, [], { onDrop: vi.fn(), onCardClick: vi.fn() });

    expect(root.querySelector(".board-error")).toBeNull();
  });
});
