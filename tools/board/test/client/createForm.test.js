// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { renderCreateForm } from "../../src/client/createForm.js";

function baseOpts(overrides = {}) {
  return {
    visible: true,
    agentOptions: ["infra", "server"],
    existingTaskIds: ["T-0001", "T-0002"],
    onCreate: vi.fn(),
    onCancel: vi.fn(),
    ...overrides
  };
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

  it("populates the agent select with an unassigned option plus agentOptions", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts());
    const values = Array.from(root.querySelector(".create-agent").options).map((o) => o.value);
    expect(values).toEqual(["", "infra", "server"]);
  });

  it("populates the dependencies multi-select with existingTaskIds", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts());
    const values = Array.from(root.querySelector(".create-deps").options).map((o) => o.value);
    expect(values).toEqual(["T-0001", "T-0002"]);
  });

  it("defaults priority to P2", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts());
    expect(root.querySelector(".create-priority").value).toBe("P2");
  });
});

describe("renderCreateForm re-render while already open", () => {
  it("does not rebuild the DOM or reset field values on a repeated visible:true render (refresh-while-editing)", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts());

    const titleInput = root.querySelector(".create-title");
    titleInput.value = "Unsaved draft title";

    renderCreateForm(root, baseOpts());

    expect(root.querySelector(".create-title")).toBe(titleInput);
    expect(root.querySelector(".create-title").value).toBe("Unsaved draft title");
  });

  it("still updates the error message on a repeated visible:true render", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts());
    root.querySelector(".create-title").value = "Unsaved draft title";

    renderCreateForm(root, baseOpts({ error: "title is required and must be a non-empty string" }));

    expect(root.querySelector(".create-error").textContent).toMatch(/title is required/i);
    expect(root.querySelector(".create-title").value).toBe("Unsaved draft title");
  });

  it("rebuilds fresh blank fields on the next open after a close (hidden -> visible transition)", () => {
    const root = document.createElement("div");
    renderCreateForm(root, baseOpts());
    root.querySelector(".create-title").value = "Leftover draft";

    renderCreateForm(root, baseOpts({ visible: false }));
    renderCreateForm(root, baseOpts({ visible: true }));

    expect(root.querySelector(".create-title").value).toBe("");
  });
});

describe("renderCreateForm submission", () => {
  it("calls onCreate with the form payload on submit", () => {
    const root = document.createElement("div");
    const onCreate = vi.fn();
    renderCreateForm(root, baseOpts({ onCreate }));

    root.querySelector(".create-title").value = "New feature";
    root.querySelector(".create-phase").value = "2";
    root.querySelector(".create-agent").value = "infra";
    root.querySelector(".create-priority").value = "P0";
    root.querySelector(".create-body").value = "## Context\nhi";
    const depsSelect = root.querySelector(".create-deps");
    Array.from(depsSelect.options).forEach((opt) => {
      opt.selected = opt.value === "T-0001";
    });
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

  it("maps the unassigned agent option to null", () => {
    const root = document.createElement("div");
    const onCreate = vi.fn();
    renderCreateForm(root, baseOpts({ onCreate }));

    root.querySelector(".create-title").value = "New feature";
    root.querySelector(".create-phase").value = "1";
    root.querySelector(".create-submit").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ agent: null, depends_on: [] })
    );
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
