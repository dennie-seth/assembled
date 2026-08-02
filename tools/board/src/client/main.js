import { createApp } from "./app.js";
import { createTerminalPanel } from "./terminalPanel.js";

const boardRoot = document.getElementById("board");
const detailRoot = document.getElementById("detail");
const consoleRoot = document.getElementById("console");
const createFormRoot = document.getElementById("create-form");
const newCardBtn = document.getElementById("new-card-btn");
const terminalRoot = document.getElementById("terminal");
const terminalToggle = document.getElementById("terminal-toggle");

const app = createApp({ boardRoot, detailRoot, consoleRoot, createFormRoot });
app.init();

if (newCardBtn) {
  newCardBtn.addEventListener("click", () => app.handleToggleCreateForm());
}

if (terminalRoot) {
  createTerminalPanel({ root: terminalRoot });
}

if (terminalToggle) {
  terminalToggle.addEventListener("click", () => {
    const panel = document.getElementById("terminal-panel");
    const collapsed = panel.classList.toggle("collapsed");
    terminalToggle.textContent = collapsed ? "Show" : "Hide";
  });
}
