import { createApp } from "./app.js";
import { createTerminalPanel } from "./terminalPanel.js";

const boardRoot = document.getElementById("board");
const detailRoot = document.getElementById("detail");
const consoleRoot = document.getElementById("console");
const createFormRoot = document.getElementById("create-form");
const sidePanelRoot = document.getElementById("side-panel");
const gitStatusRoot = document.getElementById("git-status");
const newCardBtn = document.getElementById("new-card-btn");
const terminalRoot = document.getElementById("terminal");
const terminalToggle = document.getElementById("terminal-toggle");

const app = createApp({ boardRoot, detailRoot, consoleRoot, createFormRoot, sidePanelRoot, gitStatusRoot });
app.init();

if (newCardBtn) {
  newCardBtn.addEventListener("click", () => app.handleToggleCreateForm());
}

const terminalPanelRoot = document.getElementById("terminal-panel");
let terminal = null;

if (terminalRoot) {
  terminal = createTerminalPanel({ root: terminalRoot, panelRoot: terminalPanelRoot ?? terminalRoot });
}

if (terminalToggle && terminalPanelRoot) {
  terminalToggle.addEventListener("click", () => {
    const collapsed = terminalPanelRoot.classList.toggle("collapsed");
    terminalToggle.textContent = collapsed ? "Show" : "Hide";
    if (!collapsed) {
      terminal?.focus();
    }
  });
}
