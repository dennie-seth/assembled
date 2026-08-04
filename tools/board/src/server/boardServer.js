import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FsTaskStore } from "../lib/fsTaskStore.js";
import { IdAllocator } from "../lib/idAllocator.js";
import { TaskWatcher } from "../lib/taskWatcher.js";
import { createRequestListener } from "./httpApi.js";
import { WsHub } from "./wsHub.js";
import { PtyBridge } from "./ptyBridge.js";
import { RunOrchestrator } from "../runner/runOrchestrator.js";
import { ClaudeCliRunner } from "../runner/claudeCliRunner.js";
import { createRestartCoordinator } from "../runner/serviceRestart.js";

const WS_BOARD_PATH = "/ws/board";
const WS_PTY_PATH = "/ws/pty";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export async function startBoardServer({ tasksDir, port = 0, host = "127.0.0.1" }) {
  if (host !== "127.0.0.1") {
    throw new Error("Board server must bind to 127.0.0.1 only");
  }

  const store = new FsTaskStore(tasksDir);
  const idAllocator = new IdAllocator(tasksDir);
  const hub = new WsHub();
  const watcher = new TaskWatcher(tasksDir);
  const ptyBridge = new PtyBridge({ cwd: REPO_ROOT });
  const agentsDir = path.join(REPO_ROOT, ".claude", "agents");
  const restartCoordinator = createRestartCoordinator();
  const orchestrator = new RunOrchestrator({
    store,
    hub,
    runner: new ClaudeCliRunner(),
    repoRoot: REPO_ROOT,
    worktreesDir: path.join(REPO_ROOT, "worktrees"),
    runsDir: path.join(tasksDir, ".runs"),
    agentsDir,
    rulesDir: path.join(REPO_ROOT, ".claude", "rules"),
    onIdle: () => restartCoordinator.notifyIdle()
  });

  watcher.on("task-changed", (event) => hub.broadcast(event));

  const server = http.createServer(
    createRequestListener({ store, idAllocator, orchestrator, agentsDir, repoRoot: REPO_ROOT, restartCoordinator })
  );
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === WS_BOARD_PATH) {
      hub.handleUpgrade(req, socket, head);
    } else if (pathname === WS_PTY_PATH) {
      ptyBridge.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  await watcher.start();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return {
    server,
    store,
    idAllocator,
    hub,
    watcher,
    ptyBridge,
    orchestrator,
    restartCoordinator,
    async close() {
      hub.close();
      ptyBridge.close();
      await watcher.close();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
