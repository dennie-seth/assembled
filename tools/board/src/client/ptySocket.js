const WS_PATH = "/ws/pty";

export function connectPtySocket(onMessage) {
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

export function sendPtyInput(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: "input", data }));
  }
}

export function sendPtyResize(ws, cols, rows) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }
}
