// Real-browser fixture for the viewport-fill layout invariant (T-0295 harness).
//
// Unlike drag-auto-scroll.html, this renders the FULL page skeleton index.html ships -- toolbar,
// board root, side panel and the fixed #terminal-panel -- because the layout under test is the
// interaction between `body`'s reserved bottom space and the terminal panel's actual height.
// Cards are inline data; nothing is fetched from /api.
import { renderBoard } from "../../../src/client/boardView.js";

// Enough cards in one column to make its list genuinely overflow, so internal scrolling is
// observable rather than assumed.
const STATUSES = [
  "backlog", "ready", "in-progress", "validation", "review", "done", "blocked", "retired"
];

function fixtureTask(index, status) {
  return {
    id: `T-FIXTURE-${String(index).padStart(3, "0")}`,
    title: `Fixture card ${index}`,
    status,
    priority: "P2",
    agent: "infra",
    phase: 7,
    depends_on: []
  };
}

const tasks = [];
let n = 0;
for (const status of STATUSES) {
  // backlog gets a long list (overflow); the rest get a couple so every column renders.
  const count = status === "backlog" ? 40 : 2;
  for (let i = 0; i < count; i += 1) tasks.push(fixtureTask((n += 1), status));
}

renderBoard(document.getElementById("board"), tasks, {
  onDrop: () => {},
  onCardClick: () => {},
  onRun: () => {},
  onCancel: () => {}
});

// Mirror main.js's toggle so a spec can exercise the real collapsed/expanded transition.
const panel = document.getElementById("terminal-panel");
const toggle = document.getElementById("terminal-toggle");
toggle.addEventListener("click", () => {
  const collapsed = panel.classList.toggle("collapsed");
  toggle.textContent = collapsed ? "Show" : "Hide";
});
