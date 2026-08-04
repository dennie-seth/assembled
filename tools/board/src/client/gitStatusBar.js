/**
 * Renders the git status bar showing the current branch and last commit
 * timestamp. When the branch HEAD has changed since load, an "updated" banner
 * with a reload button is shown instead so the user can refresh.
 */
export function renderGitStatusBar(root, status) {
  root.replaceChildren();

  if (!status) {
    return;
  }

  const bar = document.createElement("div");
  bar.className = "git-status-bar";

  const branchEl = document.createElement("span");
  branchEl.className = "git-status-branch";
  branchEl.textContent = status.branch ?? "unknown";
  bar.appendChild(branchEl);

  if (status.headTimestamp) {
    const ts = document.createElement("span");
    ts.className = "git-status-timestamp";
    // Show the ISO date portion only — compact and unambiguous.
    const display = status.headTimestamp.slice(0, 10);
    ts.textContent = `  ${display}`;
    ts.title = status.headTimestamp;
    bar.appendChild(ts);
  }

  if (status.updated) {
    const banner = document.createElement("span");
    banner.className = "git-status-updated";
    banner.textContent = " · branch updated";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "git-status-reload";
    btn.textContent = "Reload";
    btn.addEventListener("click", () => {
      if (typeof status.onReload === "function") {
        status.onReload();
      }
    });

    banner.appendChild(btn);
    bar.appendChild(banner);
  }

  root.appendChild(bar);
}
