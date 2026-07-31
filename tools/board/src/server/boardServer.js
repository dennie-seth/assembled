import http from "node:http";
import { FsTaskStore } from "../lib/fsTaskStore.js";
import { IdAllocator } from "../lib/idAllocator.js";
import { TaskWatcher } from "../lib/taskWatcher.js";
import { createRequestListener } from "./httpApi.js";
import { WsHub } from "./wsHub.js";

const WS_PATH = "/ws/board";

export async function startBoardServer({ tasksDir, port = 0, host = "127.0.0.1" }) {
  if (host !== "127.0.0.1") {
    throw new Error("Board server must bind to 127.0.0.1 only");
  }

  const store = new FsTaskStore(tasksDir);
  const idAllocator = new IdAllocator(tasksDir);
  const hub = new WsHub();
  const watcher = new TaskWatcher(tasksDir);

  watcher.on("task-changed", (event) => hub.broadcast(event));

  const server = http.createServer(createRequestListener({ store, idAllocator }));
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === WS_PATH) {
      hub.handleUpgrade(req, socket, head);
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
    async close() {
      hub.close();
      await watcher.close();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
