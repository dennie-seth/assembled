const TASKS_PATH = "/api/tasks";
const AGENTS_PATH = "/api/agents";
const WS_PATH = "/ws/board";
const GIT_STATUS_PATH = "/api/git/status";

/**
 * Identifies requests from the board UI -- i.e. from a person clicking things -- to the
 * server's human direction-approval gate (`src/lib/approvalGate.js`), and is what ends up in a
 * gated card's `approved_by` when someone drags it to Done. The counterpart value is the
 * `agent` that `scripts/agentCurl.js` stamps, which the gate refuses to approve on. Mirrors
 * `BOARD_UI_ACTOR` there; sent on the two routes that can approve (`PATCH` and comments).
 */
const ACTOR_HEADER = { "X-Board-Actor": "board-ui" };

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
    headers: { "Content-Type": "application/json", ...ACTOR_HEADER },
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

export async function addComment(id, text) {
  const path = `${TASKS_PATH}/${id}/comments`;
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ACTOR_HEADER },
    body: JSON.stringify({ text })
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `POST ${path} failed: ${res.status}`);
  }
  return res.json();
}

export async function uploadAttachment(id, file, uploadedBy) {
  const path = `${TASKS_PATH}/${id}/attachments`;
  const formData = new FormData();
  formData.append("file", file);
  if (uploadedBy) {
    formData.append("uploaded_by", uploadedBy);
  }
  // No Content-Type here on purpose -- the browser sets the multipart boundary itself. The
  // actor header is what lets the server attribute an omitted `uploaded_by` to the operator
  // rather than to an agent.
  const res = await fetch(path, { method: "POST", headers: { ...ACTOR_HEADER }, body: formData });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `POST ${path} failed: ${res.status}`);
  }
  return res.json();
}

export async function removeAttachment(id, filename) {
  const path = `${TASKS_PATH}/${id}/attachments/${encodeURIComponent(filename)}`;
  const res = await fetch(path, { method: "DELETE" });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `DELETE ${path} failed: ${res.status}`);
  }
  return res.json();
}

export function attachmentDownloadUrl(id, filename) {
  return `${TASKS_PATH}/${id}/attachments/${encodeURIComponent(filename)}`;
}

export function exportBacklog(navigateTo = (url) => window.location.assign(url)) {
  navigateTo("/api/tasks/export/backlog");
}

export function exportDone(navigateTo = (url) => window.location.assign(url)) {
  navigateTo("/api/tasks/export/done");
}

export async function fetchGitStatus() {
  const res = await fetch(GIT_STATUS_PATH);
  if (!res.ok) {
    throw new Error(`GET ${GIT_STATUS_PATH} failed: ${res.status}`);
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
