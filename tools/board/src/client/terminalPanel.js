import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { connectPtySocket, sendPtyInput, sendPtyResize } from "./ptySocket.js";

export function createTerminalPanel({
  root,
  panelRoot = root,
  TerminalCtor = Terminal,
  FitAddonCtor = FitAddon,
  connect = connectPtySocket,
  sendInputImpl = sendPtyInput,
  sendResizeImpl = sendPtyResize,
  requestFrame = (cb) => window.requestAnimationFrame(cb)
}) {
  const term = new TerminalCtor({ cursorBlink: true, convertEol: true });
  const fitAddon = new FitAddonCtor();
  term.loadAddon(fitAddon);
  term.open(root);
  fitAddon.fit();
  // The container isn't always laid out (stylesheet applied, panel sized) by the
  // time this runs, which locks xterm into a near-zero-column fit. Re-fit on the
  // next frame once layout has actually settled.
  requestFrame(() => fitAddon.fit());

  function focus() {
    term.focus();
  }
  // Without this, keystrokes typed before the user explicitly clicks into the
  // terminal go nowhere -- indistinguishable from the terminal being broken.
  // The panel is visible by default, so focus it as soon as it mounts.
  focus();

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

  // Clicking anywhere in the panel (header, padding -- not just xterm's own
  // cursor/selection area) refocuses the terminal. Scoped to panelRoot only,
  // so it never steals focus from card editing or other form inputs on the
  // rest of the page.
  panelRoot.addEventListener("click", focus);

  function dispose() {
    window.removeEventListener("resize", handleWindowResize);
    panelRoot.removeEventListener("click", focus);
    ws.close();
    term.dispose();
  }

  return { term, ws, fitAddon, focus, dispose };
}
