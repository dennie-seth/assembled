import { WebSocketServer } from "ws";

export class WsHub {
  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
  }

  handleUpgrade(req, socket, head) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  }

  close() {
    for (const client of this.wss.clients) {
      client.terminate();
    }
    this.wss.close();
  }
}
