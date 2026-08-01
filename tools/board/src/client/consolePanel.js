import { formatRunEvent } from "./runEvents.js";

/** The right-side live agent console: streamed run events for the selected card, tagged by phase. */
export function renderConsolePanel(root, { taskId, entries = [] }) {
  root.replaceChildren();

  if (!taskId) {
    root.hidden = true;
    return;
  }
  root.hidden = false;

  const panel = document.createElement("div");
  panel.className = "console-panel";

  const heading = document.createElement("div");
  heading.className = "console-heading";
  heading.textContent = `Agent console — ${taskId}`;
  panel.appendChild(heading);

  const list = document.createElement("div");
  list.className = "console-log";

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "console-empty";
    empty.textContent = "No output yet.";
    list.appendChild(empty);
  }

  for (const entry of entries) {
    const line = document.createElement("div");
    line.className = `console-line console-line-${entry.phase ?? "unknown"}`;
    line.textContent = formatRunEvent(entry.event, entry.phase);
    list.appendChild(line);
  }

  panel.appendChild(list);
  root.appendChild(panel);
}
