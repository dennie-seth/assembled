// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderBoard, BATCH_SIZE } from "../../src/client/boardView.js";
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

  it("shows a Re-run control on a review card and invokes onRun without triggering onCardClick", () => {
    const root = document.createElement("div");
    const onRun = vi.fn();
    const onCardClick = vi.fn();
    renderBoard(root, [task({ id: "T-0020", status: "review" })], { onDrop: vi.fn(), onCardClick, onRun });

    const rerunBtn = root.querySelector('.card[data-id="T-0020"] .card-rerun');
    expect(rerunBtn).not.toBeNull();
    expect(root.querySelector('.card[data-id="T-0020"] .card-run')).toBeNull();
    rerunBtn.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));

    expect(onRun).toHaveBeenCalledWith("T-0020");
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("shows a Re-run control on a blocked card and invokes onRun without triggering onCardClick", () => {
    const root = document.createElement("div");
    const onRun = vi.fn();
    const onCardClick = vi.fn();
    renderBoard(root, [task({ id: "T-0021", status: "blocked" })], { onDrop: vi.fn(), onCardClick, onRun });

    const rerunBtn = root.querySelector('.card[data-id="T-0021"] .card-rerun');
    expect(rerunBtn).not.toBeNull();
    expect(root.querySelector('.card[data-id="T-0021"] .card-run')).toBeNull();
    rerunBtn.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));

    expect(onRun).toHaveBeenCalledWith("T-0021");
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("renders a retired column, last, and does not show a Run control on a retired card", () => {
    const root = document.createElement("div");
    renderBoard(root, [task({ id: "T-0099", status: "retired" })], { onDrop: vi.fn(), onCardClick: vi.fn(), onRun: vi.fn() });

    const columns = root.querySelectorAll(".column");
    expect(columns[columns.length - 1].dataset.status).toBe("retired");

    const column = root.querySelector('.column[data-status="retired"]');
    expect(column.querySelector(".column-header").textContent).toContain("Retired");
    expect(column.querySelector('.card[data-id="T-0099"] .card-run')).toBeNull();
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

describe("renderBoard blocker badges", () => {
  it("renders an accessible blocker badge on a task that another task depends on", () => {
    const root = document.createElement("div");
    const blocker = task({ id: "T-0001", status: "backlog" });
    const dependent = task({ id: "T-0002", status: "backlog", depends_on: ["T-0001"] });
    renderBoard(root, [blocker, dependent], { onDrop: vi.fn(), onCardClick: vi.fn() });

    const badge = root.querySelector('.card[data-id="T-0001"] .card-blocker-badge');
    expect(badge).not.toBeNull();
    expect(badge.title || badge.getAttribute("aria-label")).toMatch(/blocks 1 task/i);
  });

  it("counts every dependent task in the badge label", () => {
    const root = document.createElement("div");
    const blocker = task({ id: "T-0001", status: "backlog" });
    const dep1 = task({ id: "T-0002", status: "backlog", depends_on: ["T-0001"] });
    const dep2 = task({ id: "T-0003", status: "backlog", depends_on: ["T-0001"] });
    renderBoard(root, [blocker, dep1, dep2], { onDrop: vi.fn(), onCardClick: vi.fn() });

    const badge = root.querySelector('.card[data-id="T-0001"] .card-blocker-badge');
    expect(badge.title || badge.getAttribute("aria-label")).toMatch(/blocks 2 tasks/i);
  });

  it("does not render a blocker badge on a task nobody depends on", () => {
    const root = document.createElement("div");
    const t = task({ id: "T-0001", status: "backlog" });
    renderBoard(root, [t], { onDrop: vi.fn(), onCardClick: vi.fn() });

    expect(root.querySelector('.card[data-id="T-0001"] .card-blocker-badge')).toBeNull();
  });

  it("does not render a blocker badge on the dependent task itself", () => {
    const root = document.createElement("div");
    const blocker = task({ id: "T-0001", status: "backlog" });
    const dependent = task({ id: "T-0002", status: "backlog", depends_on: ["T-0001"] });
    renderBoard(root, [blocker, dependent], { onDrop: vi.fn(), onCardClick: vi.fn() });

    expect(root.querySelector('.card[data-id="T-0002"] .card-blocker-badge')).toBeNull();
  });
});

describe("renderBoard auto-retry attempts badge", () => {
  it("renders an accessible badge showing the run count when a card is mid auto-retry", () => {
    const root = document.createElement("div");
    const t = task({ id: "T-0001", status: "in-progress", attempts: 2 });
    renderBoard(root, [t], { onDrop: vi.fn(), onCardClick: vi.fn() });

    const badge = root.querySelector('.card[data-id="T-0001"] .card-attempts-badge');
    expect(badge).not.toBeNull();
    expect(badge.title || badge.getAttribute("aria-label")).toMatch(/run 2 of 5/i);
  });

  it("does not render an attempts badge when the card has no attempts consumed", () => {
    const root = document.createElement("div");
    const t = task({ id: "T-0001", status: "ready", attempts: 0 });
    renderBoard(root, [t], { onDrop: vi.fn(), onCardClick: vi.fn() });

    expect(root.querySelector('.card[data-id="T-0001"] .card-attempts-badge')).toBeNull();
  });
});

describe("renderBoard backlog export button", () => {
  it("renders an export button in the backlog column when onExportBacklog is provided", () => {
    const root = document.createElement("div");
    renderBoard(root, [], { onDrop: vi.fn(), onCardClick: vi.fn(), onExportBacklog: vi.fn() });
    const exportBtn = root.querySelector('.column[data-status="backlog"] .column-export-backlog');
    expect(exportBtn).not.toBeNull();
    expect(exportBtn.textContent).toMatch(/export/i);
  });

  it("does not render an export button in non-backlog columns", () => {
    const root = document.createElement("div");
    renderBoard(root, [], { onDrop: vi.fn(), onCardClick: vi.fn(), onExportBacklog: vi.fn() });
    for (const status of ["ready", "in-progress", "done", "review", "blocked", "validation"]) {
      expect(root.querySelector(`.column[data-status="${status}"] .column-export-backlog`)).toBeNull();
    }
  });

  it("calls onExportBacklog when the export button is clicked", () => {
    const root = document.createElement("div");
    const onExportBacklog = vi.fn();
    renderBoard(root, [], { onDrop: vi.fn(), onCardClick: vi.fn(), onExportBacklog });
    const exportBtn = root.querySelector('.column[data-status="backlog"] .column-export-backlog');
    exportBtn.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
    expect(onExportBacklog).toHaveBeenCalledTimes(1);
  });

  it("does not render the export button when onExportBacklog is not provided", () => {
    const root = document.createElement("div");
    renderBoard(root, [], { onDrop: vi.fn(), onCardClick: vi.fn() });
    expect(root.querySelector(".column-export-backlog")).toBeNull();
  });
});

describe("renderBoard done export button", () => {
  it("renders an export button in the done column when onExportDone is provided", () => {
    const root = document.createElement("div");
    renderBoard(root, [], { onDrop: vi.fn(), onCardClick: vi.fn(), onExportDone: vi.fn() });
    const exportBtn = root.querySelector('.column[data-status="done"] .column-export-done');
    expect(exportBtn).not.toBeNull();
    expect(exportBtn.textContent).toMatch(/export/i);
  });

  it("does not render the done export button in non-done columns", () => {
    const root = document.createElement("div");
    renderBoard(root, [], { onDrop: vi.fn(), onCardClick: vi.fn(), onExportDone: vi.fn() });
    for (const status of ["backlog", "ready", "in-progress", "review", "blocked", "validation"]) {
      expect(root.querySelector(`.column[data-status="${status}"] .column-export-done`)).toBeNull();
    }
  });

  it("calls onExportDone when the done export button is clicked", () => {
    const root = document.createElement("div");
    const onExportDone = vi.fn();
    renderBoard(root, [], { onDrop: vi.fn(), onCardClick: vi.fn(), onExportDone });
    const exportBtn = root.querySelector('.column[data-status="done"] .column-export-done');
    exportBtn.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
    expect(onExportDone).toHaveBeenCalledTimes(1);
  });

  it("does not render the done export button when onExportDone is not provided", () => {
    const root = document.createElement("div");
    renderBoard(root, [], { onDrop: vi.fn(), onCardClick: vi.fn() });
    expect(root.querySelector(".column-export-done")).toBeNull();
  });
});

describe("renderBoard per-column sort control", () => {
  it("renders a sort select per column defaulting to id", () => {
    const root = document.createElement("div");
    renderBoard(root, [], { onDrop: vi.fn(), onCardClick: vi.fn() });

    const column = root.querySelector('.column[data-status="backlog"]');
    const sortSelect = column.querySelector(".column-sort");
    expect(sortSelect).not.toBeNull();
    expect(sortSelect.value).toBe("id");
    const values = Array.from(sortSelect.options).map((o) => o.value);
    expect(values).toEqual(["id", "priority", "agent", "phase", "oldest", "newest"]);
  });

  it("orders cards within a column by the current sort key for that column", () => {
    const root = document.createElement("div");
    const tasks = [
      task({ id: "T-0003", status: "backlog", priority: "P3" }),
      task({ id: "T-0001", status: "backlog", priority: "P0" }),
      task({ id: "T-0002", status: "backlog", priority: "P1" })
    ];
    const columnSort = new Map([["backlog", "priority"]]);
    renderBoard(root, tasks, { onDrop: vi.fn(), onCardClick: vi.fn(), columnSort });

    const ids = Array.from(root.querySelectorAll('.column[data-status="backlog"] .card')).map((c) => c.dataset.id);
    expect(ids).toEqual(["T-0001", "T-0002", "T-0003"]);
  });

  it("sorts each column independently using its own entry in columnSort", () => {
    const root = document.createElement("div");
    const tasks = [
      task({ id: "T-0003", status: "backlog", phase: 3 }),
      task({ id: "T-0001", status: "backlog", phase: 1 }),
      task({ id: "T-0004", status: "ready", phase: 3 }),
      task({ id: "T-0002", status: "ready", phase: 1 })
    ];
    const columnSort = new Map([
      ["backlog", "id"],
      ["ready", "phase"]
    ]);
    renderBoard(root, tasks, { onDrop: vi.fn(), onCardClick: vi.fn(), columnSort });

    const backlogIds = Array.from(root.querySelectorAll('.column[data-status="backlog"] .card')).map((c) => c.dataset.id);
    expect(backlogIds).toEqual(["T-0001", "T-0003"]);
    const readyIds = Array.from(root.querySelectorAll('.column[data-status="ready"] .card')).map((c) => c.dataset.id);
    expect(readyIds).toEqual(["T-0002", "T-0004"]);
  });

  it("calls onSortChange with the column status and new sort key when the sort select changes", () => {
    const root = document.createElement("div");
    const onSortChange = vi.fn();
    renderBoard(root, [], { onDrop: vi.fn(), onCardClick: vi.fn(), onSortChange });

    const select = root.querySelector('.column[data-status="ready"] .column-sort');
    select.value = "agent";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onSortChange).toHaveBeenCalledWith("ready", "agent");
  });
});

describe("BATCH_SIZE export", () => {
  it("is a positive integer", () => {
    expect(Number.isInteger(BATCH_SIZE)).toBe(true);
    expect(BATCH_SIZE).toBeGreaterThan(0);
  });
});

describe("renderBoard — batched rendering", () => {
  let root;

  beforeEach(() => {
    root = document.createElement("div");
    vi.stubGlobal("IntersectionObserver", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeTasks(count, status = "backlog") {
    return Array.from({ length: count }, (_, i) => ({
      id: `T-${String(i + 1).padStart(4, "0")}`,
      title: `Task ${i + 1}`,
      status,
      priority: "P2",
      phase: 1,
      agent: null,
      depends_on: []
    }));
  }

  it("renders all cards when count is exactly BATCH_SIZE", () => {
    const tasks = makeTasks(BATCH_SIZE, "backlog");
    renderBoard(root, tasks, { onDrop: vi.fn(), onCardClick: vi.fn() });
    const list = root.querySelector(".column-cards[data-status='backlog']");
    expect(list.querySelectorAll(".card").length).toBe(BATCH_SIZE);
    expect(list.querySelector(".batch-sentinel")).toBeNull();
  });

  it("renders all cards when count is below BATCH_SIZE", () => {
    const tasks = makeTasks(3, "backlog");
    renderBoard(root, tasks, { onDrop: vi.fn(), onCardClick: vi.fn() });
    const list = root.querySelector(".column-cards[data-status='backlog']");
    expect(list.querySelectorAll(".card").length).toBe(3);
    expect(list.querySelector(".batch-sentinel")).toBeNull();
  });

  it("renders only BATCH_SIZE cards when count exceeds BATCH_SIZE and no columnBatch", () => {
    const tasks = makeTasks(BATCH_SIZE + 5, "backlog");
    renderBoard(root, tasks, { onDrop: vi.fn(), onCardClick: vi.fn(), onShowMore: vi.fn() });
    const list = root.querySelector(".column-cards[data-status='backlog']");
    expect(list.querySelectorAll(".card").length).toBe(BATCH_SIZE);
  });

  it("adds a batch sentinel when there are more cards than the visible count", () => {
    const tasks = makeTasks(BATCH_SIZE + 1, "backlog");
    renderBoard(root, tasks, { onDrop: vi.fn(), onCardClick: vi.fn(), onShowMore: vi.fn() });
    const sentinel = root.querySelector(".batch-sentinel");
    expect(sentinel).not.toBeNull();
    expect(sentinel.dataset.status).toBe("backlog");
  });

  it("does not add a sentinel when onShowMore is not provided", () => {
    const tasks = makeTasks(BATCH_SIZE + 5, "backlog");
    renderBoard(root, tasks, { onDrop: vi.fn(), onCardClick: vi.fn() });
    expect(root.querySelector(".batch-sentinel")).toBeNull();
  });

  it("renders extended batch when columnBatch provides a higher visible count", () => {
    const tasks = makeTasks(BATCH_SIZE + 5, "backlog");
    const columnBatch = new Map([["backlog", BATCH_SIZE + 5]]);
    renderBoard(root, tasks, { onDrop: vi.fn(), onCardClick: vi.fn(), columnBatch, onShowMore: vi.fn() });
    const list = root.querySelector(".column-cards[data-status='backlog']");
    expect(list.querySelectorAll(".card").length).toBe(BATCH_SIZE + 5);
    expect(list.querySelector(".batch-sentinel")).toBeNull();
  });

  it("sentinel data-status matches the column status", () => {
    const tasks = makeTasks(BATCH_SIZE + 1, "done");
    renderBoard(root, tasks, { onDrop: vi.fn(), onCardClick: vi.fn(), onShowMore: vi.fn() });
    const sentinel = root.querySelector(".batch-sentinel");
    expect(sentinel?.dataset.status).toBe("done");
  });
});

describe("renderBoard — IntersectionObserver wiring", () => {
  let root;

  beforeEach(() => {
    root = document.createElement("div");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeTasks(count, status = "backlog") {
    return Array.from({ length: count }, (_, i) => ({
      id: `T-${String(i + 1).padStart(4, "0")}`,
      title: `Task ${i + 1}`,
      status,
      priority: "P2",
      phase: 1,
      agent: null,
      depends_on: []
    }));
  }

  it("observes sentinels when onShowMore and IntersectionObserver are available", () => {
    const observe = vi.fn();
    class MockIO {
      constructor(_cb) {}
      observe = observe;
      disconnect = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", MockIO);
    const tasks = makeTasks(BATCH_SIZE + 1, "backlog");
    renderBoard(root, tasks, { onDrop: vi.fn(), onCardClick: vi.fn(), onShowMore: vi.fn() });
    expect(observe).toHaveBeenCalled();
  });

  it("calls onShowMore with status when sentinel intersects", () => {
    const onShowMore = vi.fn();
    let observerCallback;
    class MockIO {
      constructor(cb) { observerCallback = cb; }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", MockIO);
    const tasks = makeTasks(BATCH_SIZE + 1, "backlog");
    renderBoard(root, tasks, { onDrop: vi.fn(), onCardClick: vi.fn(), onShowMore });
    const sentinel = root.querySelector(".batch-sentinel");
    observerCallback([{ isIntersecting: true, target: sentinel }]);
    expect(onShowMore).toHaveBeenCalledWith("backlog");
  });

  it("does not call onShowMore for non-intersecting entries", () => {
    const onShowMore = vi.fn();
    let observerCallback;
    class MockIO {
      constructor(cb) { observerCallback = cb; }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", MockIO);
    const tasks = makeTasks(BATCH_SIZE + 1, "backlog");
    renderBoard(root, tasks, { onDrop: vi.fn(), onCardClick: vi.fn(), onShowMore });
    const sentinel = root.querySelector(".batch-sentinel");
    observerCallback([{ isIntersecting: false, target: sentinel }]);
    expect(onShowMore).not.toHaveBeenCalled();
  });

  it("does not instantiate IntersectionObserver when onShowMore is absent", () => {
    const constructed = vi.fn();
    class MockIO {
      constructor(cb) { constructed(cb); }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", MockIO);
    const tasks = makeTasks(BATCH_SIZE + 1, "backlog");
    renderBoard(root, tasks, { onDrop: vi.fn(), onCardClick: vi.fn() });
    expect(constructed).not.toHaveBeenCalled();
  });

  it("disconnects the previous observer on re-render", () => {
    const disconnect = vi.fn();
    class MockIO {
      constructor(_cb) {}
      observe = vi.fn();
      disconnect = disconnect;
    }
    vi.stubGlobal("IntersectionObserver", MockIO);
    const tasks = makeTasks(BATCH_SIZE + 1, "backlog");
    renderBoard(root, tasks, { onDrop: vi.fn(), onCardClick: vi.fn(), onShowMore: vi.fn() });
    renderBoard(root, tasks, { onDrop: vi.fn(), onCardClick: vi.fn(), onShowMore: vi.fn() });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
