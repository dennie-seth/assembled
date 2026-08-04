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

  // Shared across the whole history so a tool_result line (which only carries a
  // tool_use_id) can be labeled with the tool name from its originating tool_use.
  const toolNamesById = new Map();
  const lines = entries.flatMap((entry) =>
    formatRunEvent(entry.event, entry.phase, { toolNamesById }).map((text) => ({ phase: entry.phase, text }))
  );

  if (lines.length === 0) {
    const empty = document.createElement("div");
    empty.className = "console-empty";
    empty.textContent = "No output yet.";
    list.appendChild(empty);
  }

  for (const { phase, text } of lines) {
    const line = document.createElement("div");
    line.className = `console-line console-line-${phase ?? "unknown"}`;
    line.textContent = text;
    list.appendChild(line);
  }

  panel.appendChild(list);
  root.appendChild(panel);
}
