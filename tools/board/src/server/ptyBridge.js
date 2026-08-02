import { WebSocketServer } from "ws";
import { spawn } from "node-pty";

const DEFAULT_SHELL = process.env.SHELL || "bash";

export class PtyBridge {
  constructor({
    spawnPty = spawn,
    shell = DEFAULT_SHELL,
    args = [],
    cwd = process.cwd(),
    env = process.env
  } = {}) {
    this.spawnPty = spawnPty;
    this.shell = shell;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.wss = new WebSocketServer({ noServer: true });
    this.sessions = new Set();
    this.wss.on("connection", (ws) => this.handleConnection(ws));
  }

  handleUpgrade(req, socket, head) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
  }

  handleConnection(ws) {
    const pty = this.spawnPty(this.shell, this.args, {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: this.cwd,
      env: this.env
    });
    this.sessions.add(pty);

    const dataSub = pty.onData((data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "data", data }));
      }
    });

    const exitSub = pty.onExit(({ exitCode, signal }) => {
      this.sessions.delete(pty);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "exit", code: exitCode, signal: signal ?? null }));
      }
    });

    const cleanup = () => {
      dataSub.dispose();
      exitSub.dispose();
      if (this.sessions.has(pty)) {
        this.sessions.delete(pty);
        pty.kill();
      }
    };

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "input" && typeof msg.data === "string") {
        pty.write(msg.data);
      } else if (msg.type === "resize" && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
        pty.resize(msg.cols, msg.rows);
      }
    });

    ws.on("close", cleanup);
  }

  close() {
    for (const pty of [...this.sessions]) {
      this.sessions.delete(pty);
      pty.kill();
    }
    this.wss.close();
  }
}
