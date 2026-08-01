import http from "node:http";
import {
  assertCanMoveToInProgress,
  UnmetDependencyError,
  DependencyCycleError
} from "../lib/dependencyGuard.js";

const TASK_ID_PATH_RE = /^\/api\/tasks\/([^/]+)$/;
const TASK_RUN_PATH_RE = /^\/api\/tasks\/([^/]+)\/run$/;
const TASK_CANCEL_PATH_RE = /^\/api\/tasks\/([^/]+)\/cancel$/;

const DEFAULTS = {
  status: "backlog",
  priority: "P2",
  agent: null,
  depends_on: [],
  body: ""
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

function requireJsonObject(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return body;
}

function sendJson(res, status, payload) {
  const raw = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(raw)
  });
  res.end(raw);
}

async function handleListTasks(store, res) {
  const tasks = await store.list();
  sendJson(res, 200, tasks);
}

async function handleCreateTask(store, idAllocator, req, res) {
  const body = requireJsonObject(await readJsonBody(req));
  if (typeof body.title !== "string" || body.title.length === 0) {
    throw new HttpError(400, "title is required and must be a non-empty string");
  }
  if (typeof body.phase !== "number" || !Number.isInteger(body.phase)) {
    throw new HttpError(400, "phase is required and must be an integer");
  }

  const id = await idAllocator.allocate();
  const task = {
    id,
    title: body.title,
    status: body.status ?? DEFAULTS.status,
    priority: body.priority ?? DEFAULTS.priority,
    phase: body.phase,
    agent: body.agent ?? DEFAULTS.agent,
    depends_on: body.depends_on ?? DEFAULTS.depends_on,
    created: body.created ?? todayIso(),
    body: body.body ?? DEFAULTS.body
  };

  let created;
  try {
    created = await store.create(task);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  sendJson(res, 201, created);
}

async function handleGetTask(store, id, res) {
  const task = await store.get(id);
  if (!task) {
    throw new HttpError(404, `Task ${id} not found`);
  }
  sendJson(res, 200, task);
}

async function handlePatchTask(store, id, req, res) {
  const body = requireJsonObject(await readJsonBody(req));
  if ("id" in body && body.id !== id) {
    throw new HttpError(400, "Cannot change a task's id");
  }

  if (body.status === "in-progress") {
    try {
      await assertCanMoveToInProgress(store, id);
    } catch (err) {
      if (err instanceof UnmetDependencyError || err instanceof DependencyCycleError) {
        throw new HttpError(409, err.message);
      }
      throw err;
    }
  }

  let updated;
  try {
    updated = await store.update(id, body);
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : 400;
    throw new HttpError(status, err.message);
  }
  sendJson(res, 200, updated);
}

async function handleRunTask(orchestrator, id, res) {
  if (!orchestrator) {
    throw new HttpError(501, "Agent Runner is not configured on this server");
  }
  const task = await orchestrator.store.get(id);
  if (!task) {
    throw new HttpError(404, `Task ${id} not found`);
  }
  if (task.status !== "ready") {
    throw new HttpError(409, `Cannot run ${id}: status is "${task.status}", expected "ready"`);
  }
  if (orchestrator.isRunning(id)) {
    throw new HttpError(409, `Task ${id} already has an active run`);
  }

  // Fire-and-forget: a run (implementer + reviewer) can take minutes. The
  // client follows progress over the board WS, not this response.
  orchestrator.runCard(id).catch((err) => {
    console.error(`Agent Runner: run failed for ${id}:`, err);
  });

  sendJson(res, 202, task);
}

async function handleCancelTask(orchestrator, id, res) {
  if (!orchestrator) {
    throw new HttpError(501, "Agent Runner is not configured on this server");
  }
  if (!orchestrator.isRunning(id)) {
    throw new HttpError(409, `No active run for ${id}`);
  }
  await orchestrator.cancelRun(id);
  const task = await orchestrator.store.get(id);
  sendJson(res, 200, task);
}

export function createRequestListener({ store, idAllocator, orchestrator }) {
  return async function requestListener(req, res) {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      const idMatch = TASK_ID_PATH_RE.exec(pathname);
      const runMatch = TASK_RUN_PATH_RE.exec(pathname);
      const cancelMatch = TASK_CANCEL_PATH_RE.exec(pathname);

      if (pathname === "/api/tasks" && req.method === "GET") {
        return await handleListTasks(store, res);
      }
      if (pathname === "/api/tasks" && req.method === "POST") {
        return await handleCreateTask(store, idAllocator, req, res);
      }
      if (idMatch && req.method === "GET") {
        return await handleGetTask(store, idMatch[1], res);
      }
      if (idMatch && req.method === "PATCH") {
        return await handlePatchTask(store, idMatch[1], req, res);
      }
      if (runMatch && req.method === "POST") {
        return await handleRunTask(orchestrator, runMatch[1], res);
      }
      if (cancelMatch && req.method === "POST") {
        return await handleCancelTask(orchestrator, cancelMatch[1], res);
      }
      if (pathname === "/api/tasks" || idMatch || runMatch || cancelMatch) {
        throw new HttpError(405, `Method ${req.method} not allowed on ${pathname}`);
      }
      throw new HttpError(404, "Not found");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) {
        console.error(err);
      }
      sendJson(res, status, { error: err.message || "Internal server error" });
    }
  };
}

export function startHttpServer({ store, idAllocator, orchestrator, port = 0, host = "127.0.0.1" }) {
  if (host !== "127.0.0.1") {
    throw new Error("HTTP API must bind to 127.0.0.1 only");
  }
  const server = http.createServer(createRequestListener({ store, idAllocator, orchestrator }));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
