import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { connectPtySocket, sendPtyInput, sendPtyResize } from "./ptySocket.js";

export function createTerminalPanel({
  root,
  TerminalCtor = Terminal,
  FitAddonCtor = FitAddon,
  connect = connectPtySocket,
  sendInputImpl = sendPtyInput,
  sendResizeImpl = sendPtyResize
}) {
  const term = new TerminalCtor({ cursorBlink: true, convertEol: true });
  const fitAddon = new FitAddonCtor();
  term.loadAddon(fitAddon);
  term.open(root);
  fitAddon.fit();

  const ws = connect((msg) => {
    if (msg.type === "data") {
      term.write(msg.data);
    } else if (msg.type === "exit") {
      const suffix = msg.code != null ? ` with code ${msg.code}` : "";
      term.write(`\r\n[process exited${suffix}]\r\n`);
    }
  });

  term.onData((data) => sendInputImpl(ws, data));
  term.onResize(({ cols, rows }) => sendResizeImpl(ws, cols, rows));

  function handleWindowResize() {
    fitAddon.fit();
  }
  window.addEventListener("resize", handleWindowResize);

  function dispose() {
    window.removeEventListener("resize", handleWindowResize);
    ws.close();
    term.dispose();
  }

  return { term, ws, fitAddon, dispose };
}
