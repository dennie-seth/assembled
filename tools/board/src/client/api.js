const TASKS_PATH = "/api/tasks";
const AGENTS_PATH = "/api/agents";
const WS_PATH = "/ws/board";

export async function fetchTasks() {
  const res = await fetch(TASKS_PATH);
  if (!res.ok) {
    throw new Error(`GET ${TASKS_PATH} failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchAgents() {
  const res = await fetch(AGENTS_PATH);
  if (!res.ok) {
    throw new Error(`GET ${AGENTS_PATH} failed: ${res.status}`);
  }
  return res.json();
}

export async function createTask(payload) {
  const res = await fetch(TASKS_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const errPayload = await res.json().catch(() => ({}));
    throw new Error(errPayload.error || `POST ${TASKS_PATH} failed: ${res.status}`);
  }
  return res.json();
}

export async function deleteTask(id) {
  const res = await fetch(`${TASKS_PATH}/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const errPayload = await res.json().catch(() => ({}));
    throw new Error(errPayload.error || `DELETE ${TASKS_PATH}/${id} failed: ${res.status}`);
  }
  return res.json();
}

export async function patchTask(id, updates) {
  const res = await fetch(`${TASKS_PATH}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates)
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `PATCH ${TASKS_PATH}/${id} failed: ${res.status}`);
  }
  return res.json();
}

async function postAction(path) {
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `POST ${path} failed: ${res.status}`);
  }
  return res.json();
}

export function runTask(id) {
  return postAction(`${TASKS_PATH}/${id}/run`);
}

export function cancelTask(id) {
  return postAction(`${TASKS_PATH}/${id}/cancel`);
}

export function exportBacklog(navigateTo = (url) => window.location.assign(url)) {
  navigateTo("/api/tasks/export/backlog");
}

export function exportDone(navigateTo = (url) => window.location.assign(url)) {
  navigateTo("/api/tasks/export/done");
}

export function connectBoardSocket(onMessage) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}${WS_PATH}`);
  ws.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    onMessage(payload);
  });
  return ws;
}
