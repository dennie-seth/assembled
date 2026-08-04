// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { renderGitStatusBar } from "../../src/client/gitStatusBar.js";

describe("renderGitStatusBar", () => {
  it("renders branch name and head timestamp", () => {
    const root = document.createElement("div");
    renderGitStatusBar(root, {
      branch: "main",
      headTimestamp: "2026-08-04T10:00:00+00:00",
      updated: false
    });
    expect(root.textContent).toContain("main");
    expect(root.textContent).toContain("2026-08-04");
  });

  it("shows no update banner when updated is false", () => {
    const root = document.createElement("div");
    renderGitStatusBar(root, { branch: "main", headTimestamp: "2026-08-04T10:00:00Z", updated: false });
    expect(root.querySelector(".git-status-updated")).toBeNull();
  });

  it("shows update banner when updated is true", () => {
    const root = document.createElement("div");
    renderGitStatusBar(root, { branch: "main", headTimestamp: "2026-08-04T10:00:00Z", updated: true });
    expect(root.querySelector(".git-status-updated")).not.toBeNull();
  });

  it("update banner has a reload button", () => {
    const root = document.createElement("div");
    renderGitStatusBar(root, { branch: "main", headTimestamp: "2026-08-04T10:00:00Z", updated: true });
    const btn = root.querySelector(".git-status-reload");
    expect(btn).not.toBeNull();
    expect(btn.tagName).toBe("BUTTON");
  });

  it("calls onReload when reload button is clicked", () => {
    const root = document.createElement("div");
    const onReload = vi.fn();
    renderGitStatusBar(root, {
      branch: "main",
      headTimestamp: "2026-08-04T10:00:00Z",
      updated: true,
      onReload
    });
    root.querySelector(".git-status-reload").click();
    expect(onReload).toHaveBeenCalled();
  });

  it("renders an empty root when given null status", () => {
    const root = document.createElement("div");
    renderGitStatusBar(root, null);
    expect(root.children.length).toBe(0);
  });

  it("clears previous content on re-render", () => {
    const root = document.createElement("div");
    renderGitStatusBar(root, { branch: "main", headTimestamp: "2026-08-04T10:00:00Z", updated: false });
    renderGitStatusBar(root, { branch: "develop", headTimestamp: "2026-08-04T11:00:00Z", updated: false });
    expect(root.textContent).not.toContain("main");
    expect(root.textContent).toContain("develop");
  });

  it("renders the feature branch name in the status bar", () => {
    const root = document.createElement("div");
    renderGitStatusBar(root, { branch: "feature/T-0116", headTimestamp: "2026-08-04T12:00:00Z", updated: false });
    expect(root.textContent).toContain("feature/T-0116");
  });
});
