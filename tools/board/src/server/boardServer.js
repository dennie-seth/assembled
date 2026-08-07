import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FsTaskStore } from "../lib/fsTaskStore.js";
import { IdAllocator } from "../lib/idAllocator.js";
import { openDb } from "../lib/db/connection.js";
import { DbTaskStore } from "../lib/db/dbTaskStore.js";
import { IdAllocatorDb } from "../lib/db/idAllocatorDb.js";
import { TaskWatcher } from "../lib/taskWatcher.js";
import { getGitStatus } from "../lib/gitInfo.js";
import { createRequestListener } from "./httpApi.js";
import { WsHub } from "./wsHub.js";
import { PtyBridge } from "./ptyBridge.js";
import { RunOrchestrator } from "../runner/runOrchestrator.js";
import { ClaudeCliRunner } from "../runner/claudeCliRunner.js";
import { createRestartCoordinator } from "../runner/serviceRestart.js";
import { createOrphanReaper } from "../runner/orphanReaper.js";
import { createSelfImprovementLoop } from "../runner/selfImprovementTrigger.js";

const WS_BOARD_PATH = "/ws/board";
const WS_PTY_PATH = "/ws/pty";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Phase 1 of docs/design/cards-to-database.md: the store/allocator pair is selectable via
 * BOARD_TASK_STORE, but the live board is NOT wired to run on "db" yet -- everything else in
 * this function (TaskWatcher, the git-commit-on-write call sites in httpApi.js/gitOps.js, the
 * Done-triggered pullDevelop) still assumes an fs-backed store and is untouched. "db" exists
 * here so the wiring point exists and DbTaskStore is provably a drop-in, not because db mode is
 * production-ready this phase. Default stays "fs" -- nothing about the live runtime path
 * changes unless this env var is set.
 */
function createTaskStoreAndAllocator({ tasksDir, taskStoreKind }) {
  if (taskStoreKind === "fs") {
    return { store: new FsTaskStore(tasksDir), idAllocator: new IdAllocator(tasksDir), db: null };
  }
  if (taskStoreKind === "db") {
    const db = openDb();
    return { store: new DbTaskStore(db), idAllocator: new IdAllocatorDb(db), db };
  }
  throw new Error(`Unknown BOARD_TASK_STORE "${taskStoreKind}": expected "fs" or "db"`);
}

export async function startBoardServer({
  tasksDir,
  port = 0,
  host = "127.0.0.1",
  taskStoreKind = process.env.BOARD_TASK_STORE || "fs"
}) {
  if (host !== "127.0.0.1") {
    throw new Error("Board server must bind to 127.0.0.1 only");
  }

  const { store, idAllocator, db } = createTaskStoreAndAllocator({ tasksDir, taskStoreKind });
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
    tasksDir,
    agentsDir,
    rulesDir: path.join(REPO_ROOT, ".claude", "rules"),
    onIdle: () => restartCoordinator.notifyIdle()
  });
  const orphanReaper = createOrphanReaper({
    store,
    hub,
    activeCardIds: orchestrator.activeCardIds,
    runsDir: path.join(tasksDir, ".runs"),
    repoRoot: REPO_ROOT,
    tasksDir
  });
  const selfImprovementLoop = createSelfImprovementLoop({
    store,
    idAllocator,
    repoRoot: REPO_ROOT,
    tasksDir
  });

  watcher.on("task-changed", (event) => hub.broadcast(event));

  const gitInfoImpl = () => getGitStatus(REPO_ROOT);
  const server = http.createServer(
    createRequestListener({
      store,
      idAllocator,
      orchestrator,
      agentsDir,
      repoRoot: REPO_ROOT,
      tasksDir,
      restartCoordinator,
      gitInfoImpl
    })
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

  // A fresh process has zero active runs by definition, so any card still sitting at
  // in-progress/validation here belongs to a run that died with the previous process --
  // reap those before anything else touches the store.
  await orphanReaper.reapOnStartup();
  orphanReaper.start();
  selfImprovementLoop.start();

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
    orphanReaper,
    selfImprovementLoop,
    async close() {
      selfImprovementLoop.stop();
      orphanReaper.stop();
      hub.close();
      ptyBridge.close();
      await watcher.close();
      await new Promise((resolve) => server.close(resolve));
      if (db) db.close();
    }
  };
}
