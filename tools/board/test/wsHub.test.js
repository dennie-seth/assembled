import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import WebSocket from "ws";
import { WsHub } from "../src/server/wsHub.js";

let server;
let hub;
let baseWsUrl;

beforeEach(async () => {
  hub = new WsHub();
  server = http.createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === "/ws/board") {
      hub.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseWsUrl = `ws://127.0.0.1:${port}`;
});

afterEach(async () => {
  hub.close();
  await new Promise((resolve) => server.close(resolve));
});

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function waitForMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    ws.once("error", reject);
  });
}

describe("WsHub", () => {
  it("accepts a connection at /ws/board and delivers broadcast messages", async () => {
    const client = new WebSocket(`${baseWsUrl}/ws/board`);
    await waitForOpen(client);

    const messagePromise = waitForMessage(client);
    hub.broadcast({ type: "task-changed", id: "T-0001" });

    expect(await messagePromise).toEqual({ type: "task-changed", id: "T-0001" });
    client.close();
  });

  it("delivers a broadcast to multiple connected clients", async () => {
    const clientA = new WebSocket(`${baseWsUrl}/ws/board`);
    const clientB = new WebSocket(`${baseWsUrl}/ws/board`);
    await Promise.all([waitForOpen(clientA), waitForOpen(clientB)]);

    const [msgA, msgB] = await Promise.all([
      waitForMessage(clientA),
      waitForMessage(clientB),
      Promise.resolve().then(() => hub.broadcast({ hello: "board" }))
    ]);

    expect(msgA).toEqual({ hello: "board" });
    expect(msgB).toEqual({ hello: "board" });
    clientA.close();
    clientB.close();
  });

  it("rejects upgrade requests on any other path", async () => {
    const client = new WebSocket(`${baseWsUrl}/ws/nope`);
    await new Promise((resolve) => {
      client.once("error", resolve);
      client.once("unexpected-response", resolve);
    });
  });
});
