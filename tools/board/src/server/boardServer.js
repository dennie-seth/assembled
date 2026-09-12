import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FsTaskStore } from "../lib/fsTaskStore.js";
import { IdAllocator } from "../lib/idAllocator.js";
import { openDb, resolveDbPath } from "../lib/db/connection.js";
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
import { acquireBoardOwnership, boardOwnerLockPath } from "../runner/boardOwnership.js";
import { createRunAwareTaskStore } from "../lib/runAwareTaskStore.js";
import { createSelfImprovementLoop } from "../runner/selfImprovementTrigger.js";
import { createAutoPullPoller } from "../runner/autoPullPoller.js";
import { createAutoLaunchPoller } from "../runner/autoLaunchPoller.js";
import { drainPendingUsageWrites } from "../runner/usageLedger.js";

const WS_BOARD_PATH = "/ws/board";
const WS_PTY_PATH = "/ws/pty";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Phase 2 of docs/design/cards-to-database.md: the store/allocator pair is selectable via
 * BOARD_TASK_STORE, and "db" is now a fully wired, production-ready mode -- every card
 * read/write path (this function's TaskWatcher wiring, httpApi.js's commit-on-write and
 * Done-triggered pullDevelop, RunOrchestrator/orphanReaper's commit-on-write, the planner's file
 * view) branches on which store is selected. The code DEFAULT stays "fs" -- flipping the live
 * board to "db" is a deliberate BOARD_TASK_STORE env change at deploy time, not something this
 * function decides on its own.
 */
/**
 * Best-effort drain of any usage-ledger write still in flight when the board shuts down (T-0367
 * fix round 3, 2026-09-12). Before this, only `RunOrchestrator.runCard()`'s own `finally` drained
 * pending writes -- there was no call site at all for an actual board-process shutdown, so a
 * terminal write dispatched fire-and-forget (`void this._recordUsage(...)`) could be lost mid-write
 * on exactly the quota-stop/crash/restart shutdowns this ticket exists to measure. Bounded by
 * `timeoutMs` so a hung or merely slow drain can never hold up the rest of shutdown past systemd's
 * stop timeout; a timeout or a rejection is logged and swallowed here, never thrown -- this is
 * instrumentation, and it must never block or fail shutdown, or change any card's verdict.
 */
async function drainUsageWritesBestEffort({ drainPendingUsageWritesFn, timeoutMs }) {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([drainPendingUsageWritesFn().then(() => "drained"), timedOut]);
    if (outcome === "timed-out") {
      console.warn(
        `Board: usage-ledger drain exceeded ${timeoutMs}ms on shutdown -- continuing without waiting further.`
      );
    }
  } catch (err) {
    console.warn("Board: usage-ledger drain failed on shutdown (ignoring):", err);
  } finally {
    clearTimeout(timer);
  }
}

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
  taskStoreKind = process.env.BOARD_TASK_STORE || "fs",
  // Injectable for tests only (a hung/rejecting drain, a short bound); production always gets the
  // real drainPendingUsageWrites and a bound comfortably inside systemd's 90s final-SIGTERM timeout.
  drainPendingUsageWritesFn = drainPendingUsageWrites,
  usageDrainTimeoutMs = Number(process.env.BOARD_USAGE_DRAIN_TIMEOUT_MS) || 3000
}) {
  if (host !== "127.0.0.1") {
    throw new Error("Board server must bind to 127.0.0.1 only");
  }

  const { store, idAllocator, db } = createTaskStoreAndAllocator({ tasksDir, taskStoreKind });
  const hub = new WsHub();
  // No tasks/*.md to watch in db mode -- card writes go straight to SQLite, and every write
  // path (httpApi.js, RunOrchestrator, orphanReaper, cardCreation) broadcasts over `hub`
  // directly instead of relying on a file watcher noticing the change (see
  // docs/design/cards-to-database.md, Phase 2's "TaskWatcher removed" row).
  const watcher = taskStoreKind === "fs" ? new TaskWatcher(tasksDir) : null;
  const dataDir = taskStoreKind === "db" ? path.dirname(resolveDbPath()) : null;
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
    taskStoreKind,
    idAllocator,
    onIdle: () => restartCoordinator.notifyIdle()
  });
  // Store-boundary transition validation -- review item #5 (§2.3). Ownership is a CAPABILITY:
  // the orchestrator above keeps the raw `store` and so may write any status for the runs it
  // owns; every other consumer below gets this guarded view, which refuses a `blocked` write to
  // a card the orchestrator is actively tracking. Liveness is read at write time from the same
  // `activeCardIds` set the reaper already shares by reference, so it stays authoritative as
  // runs start and finish. This needs no change to runOrchestrator.js.
  const guardedStore = createRunAwareTaskStore({
    store,
    isRunLive: (taskId) => orchestrator.activeCardIds.has(taskId)
  });

  // Cross-process reaping guard. `guardedStore` and the reaper's own ownership check both read
  // THIS process's `activeCardIds`, so neither can see a second board instance bound to the same
  // database -- which is precisely what reaped six live cards on 2026-09-04, when an agent's
  // `npx vitest` inherited BOARD_TASK_STORE=db and every test that built a server ran
  // reapOnStartup against the live DB. Only the lock holder gets the authority to declare
  // someone else's run dead; everything else this server does is unaffected. See
  // boardOwnership.js. In fs mode the tasks directory is already per-checkout, so the lock is
  // keyed on it rather than on a database path.
  const boardIdentityPath = taskStoreKind === "db" ? resolveDbPath() : path.join(tasksDir, ".board");
  const ownership = await acquireBoardOwnership({ lockPath: boardOwnerLockPath(boardIdentityPath) });

  const orphanReaper = createOrphanReaper({
    store: guardedStore,
    hub,
    activeCardIds: orchestrator.activeCardIds,
    runsDir: path.join(tasksDir, ".runs"),
    repoRoot: REPO_ROOT,
    tasksDir,
    taskStoreKind,
    // Ownership gates reaping only -- `enabled` already carries the ORPHAN_RECOVERY env switch,
    // and a non-owner keeps every other server capability.
    owned: ownership.owned
  });
  const selfImprovementLoop = createSelfImprovementLoop({
    store,
    idAllocator,
    repoRoot: REPO_ROOT,
    tasksDir,
    taskStoreKind,
    hub
  });
  // Companion to the Done-triggered pull in httpApi.js's handlePatchTask: closes the gap where
  // an idle board with no card reaching Done never catches up to origin/develop (see
  // docs/board-invariants.md). Reuses the same restartCoordinator/orchestrator.hasActiveRuns()
  // idle-guard as the Done path -- see autoPullPoller.js's docstring for the tick semantics.
  const autoPullPoller = createAutoPullPoller({
    repoRoot: REPO_ROOT,
    orchestrator,
    restartCoordinator
  });
  // Starts at most one ready card per tick when the board is idle and Claude usage is below
  // threshold -- the in-process replacement for an external scheduler that could not reach the
  // board. Default OFF (AUTO_LAUNCH_ENABLED), so deploying this does not switch it on; see
  // autoLaunchPoller.js's docstring for the gate order and DEPLOY.md for the env vars.
  const autoLaunchPoller = createAutoLaunchPoller({
    store,
    orchestrator,
    runsDir: path.join(tasksDir, ".runs")
  });

  if (watcher) {
    watcher.on("task-changed", (event) => hub.broadcast(event));
    // TaskWatcher emits 'error' (e.g. a parse failure on a file caught mid-write) rather than
    // throwing -- EventEmitter throws synchronously when an 'error' event has no listener, which
    // would otherwise surface as an unhandled rejection and crash nothing while looking like it did.
    watcher.on("error", (err) => {
      console.warn("Board: TaskWatcher error (ignoring, next fs event will retry):", err.message);
    });
  }

  const gitInfoImpl = () => getGitStatus(REPO_ROOT);
  const server = http.createServer(
    createRequestListener({
      store,
      idAllocator,
      orchestrator,
      agentsDir,
      repoRoot: REPO_ROOT,
      tasksDir,
      dataDir,
      taskStoreKind,
      hub,
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

  // A fresh process has zero *tracked* active runs by definition, but a card sitting at
  // in-progress/validation here may still have a genuinely live child process behind it (see
  // orphanReaper.js's own docstring -- a detached `claude` child survives a board restart with
  // the same pid). reapOnStartup applies the same pid/run-log liveness check sweepOnce does
  // before resetting anything, and only reaps what it can't corroborate as still alive.
  await orphanReaper.reapOnStartup();
  orphanReaper.start();
  selfImprovementLoop.start();
  autoPullPoller.start();
  autoLaunchPoller.start();

  if (watcher) {
    await watcher.start();
  }
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
    autoPullPoller,
    autoLaunchPoller,
    async close() {
      autoLaunchPoller.stop();
      autoPullPoller.stop();
      selfImprovementLoop.stop();
      orphanReaper.stop();
      hub.close();
      ptyBridge.close();
      if (watcher) await watcher.close();
      // Drain BEFORE the server/db close -- a terminal usage-ledger write racing shutdown must
      // land on disk while the process is still able to do I/O, not after.
      await drainUsageWritesBestEffort({ drainPendingUsageWritesFn, timeoutMs: usageDrainTimeoutMs });
      await new Promise((resolve) => server.close(resolve));
      if (db) db.close();
    }
  };
}
