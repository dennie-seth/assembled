import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBoardServer } from "./boardServer.js";

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
