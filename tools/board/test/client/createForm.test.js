// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { renderCreateForm } from "../../src/client/createForm.js";

function baseOpts(overrides = {}) {
  return {
    visible: true,
    agentOptions: ["generic", "infra", "server"],
    availableTasks: [
      { id: "T-0001", title: "First task" },
      { id: "T-0002", title: "Second task" }
    ],
    onCreate: vi.fn(),
    onCancel: vi.fn(),
    ...overrides
  };
}

function selectDep(root, taskId) {
  const select = root.querySelector(".create-deps .deps-picker-select");
  select.value = taskId;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("renderCreateForm visibility", () => {
  it("hides the root and renders nothing when not visible", () => {
    const root = document.createElement("div");
    root.hidden = false;
    renderCreateForm(root, baseOpts({ visible: false }));
    expect(root.hidden).toBe(true);
    expect(root.children.length).toBe(0);
  });

  it("shows the root with the form fields when visible", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts());
    expect(root.hidden).toBe(false);
    expect(root.querySelector(".create-title")).not.toBeNull();
    expect(root.querySelector(".create-phase")).not.toBeNull();
    expect(root.querySelector(".create-agent")).not.toBeNull();
    expect(root.querySelector(".create-priority")).not.toBeNull();
    expect(root.querySelector(".create-deps")).not.toBeNull();
    expect(root.querySelector(".create-body")).not.toBeNull();
  });

  it("populates the agent select with exactly agentOptions -- no separate unassigned placeholder", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts());
    const values = Array.from(root.querySelector(".create-agent").options).map((o) => o.value);
    expect(values).toEqual(["generic", "infra", "server"]);
  });

  it("defaults the agent select to 'generic' when it's among agentOptions", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts());
    expect(root.querySelector(".create-agent").value).toBe("generic");
  });

  it("falls back to the first agent option when 'generic' is not among agentOptions", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts({ agentOptions: ["infra", "server"] }));
    expect(root.querySelector(".create-agent").value).toBe("infra");
  });

  it("populates the dependency picker dropdown with availableTasks as 'id — title'", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts());
    const select = root.querySelector(".create-deps .deps-picker-select");
    const labels = Array.from(select.options)
      .filter((o) => o.value !== "")
      .map((o) => o.textContent);
    expect(labels).toEqual(["T-0001 — First task", "T-0002 — Second task"]);
  });

  it("defaults priority to P2", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts());
    expect(root.querySelector(".create-priority").value).toBe("P2");
  });
});

describe("renderCreateForm dependency picker", () => {
  it("adds a removable chip and drops the option from the dropdown when a dependency is picked", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts());

    selectDep(root, "T-0001");

    const chips = root.querySelectorAll(".create-deps .deps-chip");
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toContain("T-0001 — First task");
    const remaining = Array.from(root.querySelector(".create-deps .deps-picker-select").options)
      .map((o) => o.value)
      .filter(Boolean);
    expect(remaining).toEqual(["T-0002"]);
  });

  it("removing a chip makes the dependency reappear in the dropdown", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts());

    selectDep(root, "T-0001");
    root.querySelector('.create-deps .deps-chip[data-id="T-0001"] .deps-chip-remove').dispatchEvent(
      new Event("click", { bubbles: true })
    );

    expect(root.querySelectorAll(".create-deps .deps-chip").length).toBe(0);
    const values = Array.from(root.querySelector(".create-deps .deps-picker-select").options)
      .map((o) => o.value)
      .filter(Boolean);
    expect(values).toEqual(["T-0001", "T-0002"]);
  });
});

describe("renderCreateForm submission", () => {
  it("calls onCreate with the form payload, including picked dependencies, on submit", () => {
    const root = document.createElement("div");
    const onCreate = vi.fn();
    renderCreateForm(root, baseOpts({ onCreate }));

    root.querySelector(".create-title").value = "New feature";
    root.querySelector(".create-phase").value = "2";
    root.querySelector(".create-agent").value = "infra";
    root.querySelector(".create-priority").value = "P0";
    root.querySelector(".create-body").value = "## Context\nhi";
    selectDep(root, "T-0001");
    root.querySelector(".create-submit").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onCreate).toHaveBeenCalledWith({
      title: "New feature",
      phase: 2,
      agent: "infra",
      priority: "P0",
      depends_on: ["T-0001"],
      body: "## Context\nhi"
    });
  });

  it("excludes a removed dependency from the created payload", () => {
    const root = document.createElement("div");
    const onCreate = vi.fn();
    renderCreateForm(root, baseOpts({ onCreate }));

    root.querySelector(".create-title").value = "New feature";
    root.querySelector(".create-phase").value = "1";
    selectDep(root, "T-0001");
    selectDep(root, "T-0002");
    root.querySelector('.create-deps .deps-chip[data-id="T-0001"] .deps-chip-remove').dispatchEvent(
      new Event("click", { bubbles: true })
    );
    root.querySelector(".create-submit").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ depends_on: ["T-0002"] }));
  });

  it("defaults to the generic agent when submitted without touching the agent select", () => {
    const root = document.createElement("div");
    const onCreate = vi.fn();
    renderCreateForm(root, baseOpts({ onCreate }));

    root.querySelector(".create-title").value = "New feature";
    root.querySelector(".create-phase").value = "1";
    root.querySelector(".create-submit").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "generic", depends_on: [] })
    );
  });

  it("omits the agent field entirely when the dropdown has no options (server-side default applies)", () => {
    const root = document.createElement("div");
    const onCreate = vi.fn();
    renderCreateForm(root, baseOpts({ onCreate, agentOptions: [] }));

    root.querySelector(".create-title").value = "New feature";
    root.querySelector(".create-phase").value = "1";
    root.querySelector(".create-submit").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onCreate).toHaveBeenCalledOnce();
    expect(onCreate.mock.calls[0][0]).not.toHaveProperty("agent");
  });

  it("shows a validation error and does not call onCreate when title is empty", () => {
    const root = document.createElement("div");
    const onCreate = vi.fn();
    renderCreateForm(root, baseOpts({ onCreate }));

    root.querySelector(".create-phase").value = "1";
    root.querySelector(".create-submit").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(root.querySelector(".create-error").textContent).toMatch(/title/i);
  });

  it("shows a validation error and does not call onCreate when phase is not an integer", () => {
    const root = document.createElement("div");
    const onCreate = vi.fn();
    renderCreateForm(root, baseOpts({ onCreate }));

    root.querySelector(".create-title").value = "New feature";
    root.querySelector(".create-phase").value = "";
    root.querySelector(".create-submit").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(root.querySelector(".create-error").textContent).toMatch(/phase/i);
  });

  it("calls onCancel when Cancel is clicked", () => {
    const root = document.createElement("div");
    const onCancel = vi.fn();
    renderCreateForm(root, baseOpts({ onCancel }));

    root.querySelector(".create-cancel").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onCancel).toHaveBeenCalled();
  });

  it("surfaces a server-provided error message via setError-style prop", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts({ error: "title is required and must be a non-empty string" }));
    expect(root.querySelector(".create-error").textContent).toMatch(/title is required/i);
  });
});

describe("renderCreateForm refresh preservation (does not clobber an open form)", () => {
  it("keeps a picked dependency chip and typed title across a re-render while still visible", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts());

    const titleInput = root.querySelector(".create-title");
    titleInput.value = "Unsaved title";
    selectDep(root, "T-0001");

    // Simulate a board refresh event calling back through with the same visible:true.
    renderCreateForm(root, baseOpts());

    expect(root.querySelector(".create-title")).toBe(titleInput);
    expect(root.querySelector(".create-title").value).toBe("Unsaved title");
    expect(root.querySelectorAll(".create-deps .deps-chip").length).toBe(1);
    expect(root.querySelector(".create-deps .deps-chip").textContent).toContain("T-0001");
  });

  it("still patches in a new error message on a refresh re-render while open", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts());
    renderCreateForm(root, baseOpts({ error: "title is required and must be a non-empty string" }));
    expect(root.querySelector(".create-error").textContent).toMatch(/title is required/i);
  });

  it("does a clean rebuild on a genuine hidden -> visible open", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts({ visible: false }));
    renderCreateForm(root, baseOpts());
    expect(root.querySelectorAll(".create-deps .deps-chip").length).toBe(0);
    expect(root.querySelector(".create-title").value).toBe("");
  });
});
