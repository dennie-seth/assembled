// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { renderDetailPanel } from "../../src/client/detailPanel.js";

function task(overrides = {}) {
  return {
    id: "T-0001",
    title: "Sample task",
    status: "backlog",
    priority: "P2",
    phase: 1,
    agent: "infra",
    depends_on: [],
    created: "2026-07-31",
    body: "## Context\nsome context\n\n## Acceptance\n- [ ] do it",
    ...overrides
  };
}

function baseOpts(overrides = {}) {
  return {
    onSave: vi.fn(),
    onClose: vi.fn(),
    onDelete: vi.fn(),
    agentOptions: ["infra", "server", "client", "assets", "audio"],
    allTasks: [
      { id: "T-0001", title: "Sample task" },
      { id: "T-0002", title: "Second task" },
      { id: "T-0003", title: "Third task" }
    ],
    ...overrides
  };
}

function selectDep(root, taskId) {
  const select = root.querySelector(".detail-deps-edit .deps-picker-select");
  select.value = taskId;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("renderDetailPanel", () => {
  it("hides the root and renders nothing when there is no selected task", () => {
    const root = document.createElement("div");
    root.hidden = false;
    renderDetailPanel(root, null, baseOpts());
    expect(root.hidden).toBe(true);
    expect(root.children.length).toBe(0);
  });

  it("shows the root and renders the task's title, priority and status", () => {
    const root = document.createElement("div");
    const t = task({ title: "Do the thing", priority: "P0", status: "review" });
    renderDetailPanel(root, t, baseOpts());

    expect(root.hidden).toBe(false);
    expect(root.querySelector(".detail-title").value).toBe("Do the thing");
    expect(root.querySelector(".detail-priority").value).toBe("P0");
    expect(root.querySelector(".detail-status").value).toBe("review");
  });

  it("renders the depends_on list", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ depends_on: ["T-0002", "T-0003"] }), baseOpts());
    expect(root.querySelector(".detail-deps").textContent).toContain("T-0002");
    expect(root.querySelector(".detail-deps").textContent).toContain("T-0003");
  });

  it("shows a no-dependencies message when depends_on is empty", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ depends_on: [] }), baseOpts());
    expect(root.querySelector(".detail-deps").textContent).toMatch(/no dependencies/i);
  });

  it("renders the markdown body as HTML in the preview pane", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task(), baseOpts());
    const preview = root.querySelector(".detail-body-preview");
    expect(preview.querySelector("h2").textContent).toBe("Context");
    expect(preview.querySelector(".checklist")).not.toBeNull();
  });

  it("calls onClose when the close button is clicked", () => {
    const root = document.createElement("div");
    const onClose = vi.fn();
    renderDetailPanel(root, task(), baseOpts({ onClose }));
    root.querySelector(".detail-close").dispatchEvent(new Event("click", { bubbles: true }));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onSave with only the changed fields when Save is clicked", () => {
    const root = document.createElement("div");
    const onSave = vi.fn();
    const t = task({ id: "T-0007" });
    renderDetailPanel(root, t, baseOpts({ onSave }));

    root.querySelector(".detail-title").value = "Renamed";
    root.querySelector(".detail-priority").value = "P0";
    root.querySelector(".detail-save").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onSave).toHaveBeenCalledWith("T-0007", { title: "Renamed", priority: "P0" });
  });

  it("does not call onSave when nothing was edited", () => {
    const root = document.createElement("div");
    const onSave = vi.fn();
    renderDetailPanel(root, task(), baseOpts({ onSave }));
    root.querySelector(".detail-save").dispatchEvent(new Event("click", { bubbles: true }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("replaces previously rendered content on re-render", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ id: "T-0001" }), baseOpts());
    renderDetailPanel(root, task({ id: "T-0002" }), baseOpts());
    expect(root.querySelectorAll(".detail-panel").length).toBe(1);
  });
});

describe("renderDetailPanel editable agent/phase/depends_on", () => {
  it("renders the agent select with the current value and available options", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ agent: "server" }), baseOpts());
    const select = root.querySelector(".detail-agent");
    expect(select.value).toBe("server");
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(["", "infra", "server", "client", "assets", "audio"]));
  });

  it("renders an unassigned option that maps to null", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ agent: null }), baseOpts());
    const select = root.querySelector(".detail-agent");
    expect(select.value).toBe("");
  });

  it("includes the current agent value even if it is not in agentOptions", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ agent: "legacy-agent" }), baseOpts({ agentOptions: ["infra"] }));
    const select = root.querySelector(".detail-agent");
    expect(select.value).toBe("legacy-agent");
  });

  it("renders the phase number input with the current value", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ phase: 3 }), baseOpts());
    expect(root.querySelector(".detail-phase").value).toBe("3");
  });

  it("renders a dependency picker excluding the task itself, with depends_on shown as removable chips", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ id: "T-0001", depends_on: ["T-0002"] }), baseOpts());

    const select = root.querySelector(".detail-deps-edit .deps-picker-select");
    const optionValues = Array.from(select.options).map((o) => o.value).filter(Boolean);
    expect(optionValues).not.toContain("T-0001");
    expect(optionValues).toEqual(["T-0003"]);

    const chips = root.querySelectorAll(".detail-deps-edit .deps-chip");
    expect(chips.length).toBe(1);
    expect(chips[0].dataset.id).toBe("T-0002");
  });

  it("includes agent, phase, and depends_on in the Save patch when changed", () => {
    const root = document.createElement("div");
    const onSave = vi.fn();
    renderDetailPanel(root, task({ id: "T-0001", agent: "infra", phase: 1, depends_on: ["T-0002"] }), baseOpts({ onSave }));

    root.querySelector(".detail-agent").value = "server";
    root.querySelector(".detail-phase").value = "5";
    root.querySelector('.detail-deps-edit .deps-chip[data-id="T-0002"] .deps-chip-remove').dispatchEvent(
      new Event("click", { bubbles: true })
    );
    selectDep(root, "T-0003");
    root.querySelector(".detail-save").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onSave).toHaveBeenCalledWith("T-0001", { agent: "server", phase: 5, depends_on: ["T-0003"] });
  });

  it("maps the unassigned select option back to a null agent on save", () => {
    const root = document.createElement("div");
    const onSave = vi.fn();
    renderDetailPanel(root, task({ id: "T-0001", agent: "infra" }), baseOpts({ onSave }));

    root.querySelector(".detail-agent").value = "";
    root.querySelector(".detail-save").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onSave).toHaveBeenCalledWith("T-0001", { agent: null });
  });
});

describe("renderDetailPanel review metadata (branch/commit)", () => {
  it("shows the branch and a shortened commit when present", () => {
    const root = document.createElement("div");
    renderDetailPanel(
      root,
      task({ status: "review", branch: "feature/T-0001", commit: "abc1234def5678abc1234def5678abc1234def5" }),
      baseOpts()
    );
    const info = root.querySelector(".detail-branch");
    expect(info).not.toBeNull();
    expect(info.textContent).toContain("feature/T-0001");
    expect(info.textContent).toContain("abc1234");
  });

  it("does not render branch metadata when absent", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ branch: null, commit: null }), baseOpts());
    expect(root.querySelector(".detail-branch")).toBeNull();
  });
});

describe("renderDetailPanel auto-retry attempt counter", () => {
  it("shows the run count out of 5 when the card has consumed auto-retry attempts", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ status: "in-progress", attempts: 3 }), baseOpts());
    const info = root.querySelector(".detail-attempts");
    expect(info).not.toBeNull();
    expect(info.textContent).toContain("3");
    expect(info.textContent).toContain("5");
  });

  it("does not render the attempt counter when attempts is 0 or absent", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ attempts: 0 }), baseOpts());
    expect(root.querySelector(".detail-attempts")).toBeNull();
  });
});

describe("renderDetailPanel comments (Feature A: human feedback for iterative re-runs)", () => {
  it("does not render the comments section when onAddComment is not provided", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task(), baseOpts());
    expect(root.querySelector(".detail-comments")).toBeNull();
  });

  it("shows a no-comments message when the task has none", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ comments: [] }), baseOpts({ onAddComment: vi.fn() }));
    expect(root.querySelector(".detail-comments-empty")).not.toBeNull();
  });

  it("renders each existing comment with author, timestamp, and text", () => {
    const root = document.createElement("div");
    const t = task({
      comments: [
        { author: "Dennie", text: "CI failed on lint, please fix.", timestamp: "2026-08-05T12:00:00.000Z" },
        { author: "Dennie", text: "Also check the build.", timestamp: "2026-08-05T13:00:00.000Z" }
      ]
    });
    renderDetailPanel(root, t, baseOpts({ onAddComment: vi.fn() }));

    const items = root.querySelectorAll(".detail-comment");
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain("Dennie");
    expect(items[0].textContent).toContain("CI failed on lint, please fix.");
    expect(items[0].textContent).toContain("2026-08-05T12:00:00.000Z");
    expect(items[1].textContent).toContain("Also check the build.");
  });

  it("defaults to an empty comments list when task.comments is absent", () => {
    const root = document.createElement("div");
    const taskWithoutComments = task();
    delete taskWithoutComments.comments;
    renderDetailPanel(root, taskWithoutComments, baseOpts({ onAddComment: vi.fn() }));
    expect(root.querySelector(".detail-comments-empty")).not.toBeNull();
  });

  it("calls onAddComment with the task id and trimmed text, then clears the input", () => {
    const root = document.createElement("div");
    const onAddComment = vi.fn();
    renderDetailPanel(root, task({ id: "T-0009" }), baseOpts({ onAddComment }));

    const input = root.querySelector(".detail-comment-input");
    input.value = "  please fix the CI failure  ";
    root.querySelector(".detail-comment-add").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onAddComment).toHaveBeenCalledWith("T-0009", "please fix the CI failure");
    expect(input.value).toBe("");
  });

  it("does not call onAddComment for blank/whitespace-only input", () => {
    const root = document.createElement("div");
    const onAddComment = vi.fn();
    renderDetailPanel(root, task(), baseOpts({ onAddComment }));

    root.querySelector(".detail-comment-input").value = "   ";
    root.querySelector(".detail-comment-add").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onAddComment).not.toHaveBeenCalled();
  });
});

describe("renderDetailPanel draft preservation across live re-renders", () => {
  // A re-render triggered by a WS "changed" event (see app.js's handleSocketMessage)
  // used to call root.replaceChildren() unconditionally, tearing down and rebuilding
  // a brand-new <textarea> from server state -- wiping any comment the user was
  // mid-typing. These simulate that exact re-render (same task id, called again while
  // focused) and assert the draft, focus, and caret survive it.

  it("preserves an in-progress comment draft across a re-render of the same task", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const t = task({ id: "T-0137" });
    renderDetailPanel(root, t, baseOpts({ onAddComment: vi.fn() }));

    const input = root.querySelector(".detail-comment-input");
    input.focus();
    input.value = "please check the lo";

    // Simulate a live-update tick for the same card (e.g. a status/attempts change
    // broadcast over the board socket) re-rendering the still-selected detail panel.
    renderDetailPanel(root, task({ id: "T-0137", attempts: 1 }), baseOpts({ onAddComment: vi.fn() }));

    const newInput = root.querySelector(".detail-comment-input");
    expect(newInput).not.toBe(input);
    expect(newInput.value).toBe("please check the lo");
    document.body.removeChild(root);
  });

  it("keeps focus and caret position on the comment textarea across a re-render", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const t = task({ id: "T-0137" });
    renderDetailPanel(root, t, baseOpts({ onAddComment: vi.fn() }));

    const input = root.querySelector(".detail-comment-input");
    input.focus();
    input.value = "please check the log";
    input.setSelectionRange(7, 12);

    renderDetailPanel(root, task({ id: "T-0137" }), baseOpts({ onAddComment: vi.fn() }));

    const newInput = root.querySelector(".detail-comment-input");
    expect(document.activeElement).toBe(newInput);
    expect(newInput.selectionStart).toBe(7);
    expect(newInput.selectionEnd).toBe(12);
    document.body.removeChild(root);
  });

  it("still updates the comments list around the preserved draft when a new comment arrives", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const t = task({ id: "T-0137", comments: [] });
    renderDetailPanel(root, t, baseOpts({ onAddComment: vi.fn() }));

    const input = root.querySelector(".detail-comment-input");
    input.focus();
    input.value = "still typing my reply";

    const updated = task({
      id: "T-0137",
      comments: [{ author: "Reviewer", text: "fix the lint error", timestamp: "2026-08-06T00:00:00.000Z" }]
    });
    renderDetailPanel(root, updated, baseOpts({ onAddComment: vi.fn() }));

    expect(root.querySelector(".detail-comment-input").value).toBe("still typing my reply");
    expect(root.querySelectorAll(".detail-comment").length).toBe(1);
    expect(root.querySelector(".detail-comment").textContent).toContain("fix the lint error");
    document.body.removeChild(root);
  });

  it("does not bleed a draft over to a newly selected, different task", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    renderDetailPanel(root, task({ id: "T-0137" }), baseOpts({ onAddComment: vi.fn() }));

    const input = root.querySelector(".detail-comment-input");
    input.focus();
    input.value = "draft for T-0137";

    renderDetailPanel(root, task({ id: "T-0200" }), baseOpts({ onAddComment: vi.fn() }));

    expect(root.querySelector(".detail-comment-input").value).toBe("");
    document.body.removeChild(root);
  });

  it("preserves an in-progress body-textarea edit across a re-render of the same task", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    renderDetailPanel(root, task({ id: "T-0137" }), baseOpts());

    const body = root.querySelector(".detail-body-edit");
    body.focus();
    body.value = "## Context\nediting this in place";

    renderDetailPanel(root, task({ id: "T-0137", attempts: 2 }), baseOpts());

    const newBody = root.querySelector(".detail-body-edit");
    expect(newBody.value).toBe("## Context\nediting this in place");
    expect(document.activeElement).toBe(newBody);
    document.body.removeChild(root);
  });

  it("preserves an in-progress title edit across a re-render of the same task", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    renderDetailPanel(root, task({ id: "T-0137", title: "Original title" }), baseOpts());

    const titleInput = root.querySelector(".detail-title");
    titleInput.focus();
    titleInput.value = "Renaming in progr";

    renderDetailPanel(root, task({ id: "T-0137", title: "Original title" }), baseOpts());

    expect(root.querySelector(".detail-title").value).toBe("Renaming in progr");
    document.body.removeChild(root);
  });

  it("does not restore a stale draft once the field has lost focus", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    renderDetailPanel(root, task({ id: "T-0137" }), baseOpts({ onAddComment: vi.fn() }));

    const input = root.querySelector(".detail-comment-input");
    input.focus();
    input.value = "typed then blurred";
    input.blur();

    renderDetailPanel(root, task({ id: "T-0137" }), baseOpts({ onAddComment: vi.fn() }));

    expect(root.querySelector(".detail-comment-input").value).toBe("");
    document.body.removeChild(root);
  });
});

describe("renderDetailPanel attachments", () => {
  it("does not render the attachments section when onUploadAttachment is not provided", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task(), baseOpts());
    expect(root.querySelector(".detail-attachments")).toBeNull();
  });

  it("shows a no-attachments message when the task has none", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ attachments: [] }), baseOpts({ onUploadAttachment: vi.fn() }));
    expect(root.querySelector(".detail-attachments-empty")).not.toBeNull();
  });

  it("defaults to an empty attachments list when task.attachments is absent", () => {
    const root = document.createElement("div");
    const taskWithoutAttachments = task();
    delete taskWithoutAttachments.attachments;
    renderDetailPanel(root, taskWithoutAttachments, baseOpts({ onUploadAttachment: vi.fn() }));
    expect(root.querySelector(".detail-attachments-empty")).not.toBeNull();
  });

  it("renders each attachment with a filename/size download link", () => {
    const root = document.createElement("div");
    const t = task({
      id: "T-0009",
      attachments: [
        {
          filename: "reference.png",
          size: 2048,
          mimetype: "image/png",
          uploaded_by: "Dennie",
          uploaded_at: "2026-08-05T12:00:00.000Z"
        },
        {
          filename: "weights.bin",
          size: 10,
          mimetype: "application/octet-stream",
          uploaded_by: "Dennie",
          uploaded_at: "2026-08-05T13:00:00.000Z"
        }
      ]
    });
    renderDetailPanel(root, t, baseOpts({ onUploadAttachment: vi.fn() }));

    const items = root.querySelectorAll(".detail-attachment");
    expect(items.length).toBe(2);
    const links = root.querySelectorAll(".detail-attachment-link");
    expect(links[0].getAttribute("href")).toBe("/api/tasks/T-0009/attachments/reference.png");
    expect(links[0].textContent).toContain("reference.png");
    expect(links[0].textContent).toContain("2.0 KB");
    expect(links[1].getAttribute("href")).toBe("/api/tasks/T-0009/attachments/weights.bin");
  });

  it("renders an inline image thumbnail only for image mimetypes", () => {
    const root = document.createElement("div");
    const t = task({
      id: "T-0009",
      attachments: [
        {
          filename: "reference.png",
          size: 10,
          mimetype: "image/png",
          uploaded_by: "Dennie",
          uploaded_at: "2026-08-05T12:00:00.000Z"
        },
        {
          filename: "weights.bin",
          size: 10,
          mimetype: "application/octet-stream",
          uploaded_by: "Dennie",
          uploaded_at: "2026-08-05T13:00:00.000Z"
        }
      ]
    });
    renderDetailPanel(root, t, baseOpts({ onUploadAttachment: vi.fn() }));

    const thumbs = root.querySelectorAll(".detail-attachment-thumb");
    expect(thumbs.length).toBe(1);
    expect(thumbs[0].getAttribute("src")).toBe("/api/tasks/T-0009/attachments/reference.png");
  });

  it("calls onUploadAttachment with the task id and selected file, then clears the input", () => {
    const root = document.createElement("div");
    const onUploadAttachment = vi.fn();
    renderDetailPanel(root, task({ id: "T-0009" }), baseOpts({ onUploadAttachment }));

    const fileInput = root.querySelector(".detail-attachment-input");
    const file = new File(["hello"], "a.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onUploadAttachment).toHaveBeenCalledWith("T-0009", file);
    expect(fileInput.value).toBe("");
  });

  it("does not render a remove control when onRemoveAttachment is not provided", () => {
    const root = document.createElement("div");
    const t = task({
      attachments: [
        { filename: "a.png", size: 1, mimetype: "image/png", uploaded_by: "D", uploaded_at: "2026-08-05T12:00:00.000Z" }
      ]
    });
    renderDetailPanel(root, t, baseOpts({ onUploadAttachment: vi.fn() }));
    expect(root.querySelector(".detail-attachment-remove")).toBeNull();
  });

  it("calls onRemoveAttachment with the task id and filename", () => {
    const root = document.createElement("div");
    const onRemoveAttachment = vi.fn();
    const t = task({
      id: "T-0009",
      attachments: [
        { filename: "a.png", size: 1, mimetype: "image/png", uploaded_by: "D", uploaded_at: "2026-08-05T12:00:00.000Z" }
      ]
    });
    renderDetailPanel(root, t, baseOpts({ onUploadAttachment: vi.fn(), onRemoveAttachment }));

    root.querySelector(".detail-attachment-remove").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onRemoveAttachment).toHaveBeenCalledWith("T-0009", "a.png");
  });
});

describe("renderDetailPanel delete", () => {
  it("shows a delete button that reveals a confirmation step instead of deleting immediately", () => {
    const root = document.createElement("div");
    const onDelete = vi.fn();
    renderDetailPanel(root, task(), baseOpts({ onDelete }));

    root.querySelector(".detail-delete").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(root.querySelector(".detail-delete-confirm").hidden).toBe(false);
  });

  it("calls onDelete only after confirming", () => {
    const root = document.createElement("div");
    const onDelete = vi.fn();
    const t = task({ id: "T-0009" });
    renderDetailPanel(root, t, baseOpts({ onDelete }));

    root.querySelector(".detail-delete").dispatchEvent(new Event("click", { bubbles: true }));
    root.querySelector(".detail-delete-confirm-yes").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onDelete).toHaveBeenCalledWith("T-0009");
  });

  it("cancelling the confirmation does not call onDelete", () => {
    const root = document.createElement("div");
    const onDelete = vi.fn();
    renderDetailPanel(root, task(), baseOpts({ onDelete }));

    root.querySelector(".detail-delete").dispatchEvent(new Event("click", { bubbles: true }));
    root.querySelector(".detail-delete-confirm-no").dispatchEvent(new Event("click", { bubbles: true }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(root.querySelector(".detail-delete-confirm").hidden).toBe(true);
  });

  it("disables the delete button for a task with an active run (in-progress)", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ status: "in-progress" }), baseOpts());
    expect(root.querySelector(".detail-delete").disabled).toBe(true);
  });

  it("disables the delete button for a task with an active run (validation)", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ status: "validation" }), baseOpts());
    expect(root.querySelector(".detail-delete").disabled).toBe(true);
  });

  it("leaves the delete button enabled for a task without an active run", () => {
    const root = document.createElement("div");
    renderDetailPanel(root, task({ status: "ready" }), baseOpts());
    expect(root.querySelector(".detail-delete").disabled).toBe(false);
  });
});
