import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBoardServer } from "./boardServer.js";

// Last-resort safety net: source-level fixes (e.g. claudeCliRunner.js's synchronous 'error'
// listener) close the specific windows we know about, but this process runs every card's agent
// spawn and lifecycle for as long as the board is up, and a single unforeseen throw anywhere in
// that surface must never take the whole server down with it -- see the T-0185 incident, where
// an unlistened child 'error' event crashed the process outright. Log and keep running rather
// than exit; a wedged or failed card is recoverable (retry, reaper, manual intervention), a dead
// server is not.
process.on("uncaughtException", (err) => {
  console.error("[board] uncaughtException (process kept alive):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[board] unhandledRejection (process kept alive):", reason);
});

const DEFAULT_TASKS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../tasks"
);

const board = await startBoardServer({
  tasksDir: process.env.BOARD_TASKS_DIR || DEFAULT_TASKS_DIR,
  port: Number(process.env.BOARD_PORT) || 4173,
  host: "127.0.0.1"
});

const { port } = board.server.address();
console.log(`assembled-board listening on http://127.0.0.1:${port} (ws: /ws/board)`);
