const TASKS_PATH = "/api/tasks";
const WS_PATH = "/ws/board";

export async function fetchTasks() {
  const res = await fetch(TASKS_PATH);
  if (!res.ok) {
    throw new Error(`GET ${TASKS_PATH} failed: ${res.status}`);
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
