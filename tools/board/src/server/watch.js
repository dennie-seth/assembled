import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWatchSupervisor } from "./watchSupervisor.js";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const BOARD_DIR = path.resolve(SERVER_DIR, "../..");
const DEFAULT_REPO_ROOT = path.resolve(SERVER_DIR, "../../../..");
const ENTRY_PATH = path.join(SERVER_DIR, "index.js");

const repoRoot = process.env.BOARD_REPO_ROOT ? path.resolve(process.env.BOARD_REPO_ROOT) : DEFAULT_REPO_ROOT;
const tasksDir = process.env.BOARD_TASKS_DIR ? path.resolve(process.env.BOARD_TASKS_DIR) : path.join(repoRoot, "tasks");
const watchPaths = process.env.BOARD_WATCH_PATHS
  ? process.env.BOARD_WATCH_PATHS.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  : [path.join(BOARD_DIR, "src")];

const supervisor = createWatchSupervisor({
  entryPath: ENTRY_PATH,
  watchPaths,
  runsDir: path.join(tasksDir, ".runs"),
  boardDirs: [repoRoot]
});

supervisor.start();

async function shutdown(signal) {
  console.log(`[board watch] received ${signal}, shutting down...`);
  try {
    await supervisor.stop();
  } catch (err) {
    console.error("[board watch] error while stopping during shutdown:", err);
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
