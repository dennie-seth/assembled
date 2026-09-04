// Real-browser fixture for the drag auto-scroll harness (T-0295). Renders the board client's
// actual `renderBoard` (same module `app.js` uses in production) against synthetic tasks, so the
// drag/scroll wiring under test -- dragstart offset capture, the dragover/dragleave listeners,
// `createAutoScrollController` -- is the genuine production code path, not a reimplementation.
// No network: tasks are inline data, never fetched from `/api`.
import { renderBoard } from "../../../src/client/boardView.js";

const CARD_COUNT = 40;

function fixtureTask(index) {
  return {
    id: `T-FIXTURE-${String(index).padStart(3, "0")}`,
    title: `Fixture card ${index}`,
    status: "backlog",
    priority: "P2",
    agent: "infra",
    phase: 7
  };
}

const tasks = Array.from({ length: CARD_COUNT }, (_, i) => fixtureTask(i + 1));

renderBoard(document.getElementById("board"), tasks, {
  onDrop: () => {},
  onCardClick: () => {},
  onRun: () => {},
  onCancel: () => {}
});
