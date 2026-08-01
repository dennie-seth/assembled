import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { startBoardServer } from "../src/server/boardServer.js";
import { serializeTask } from "../src/lib/taskParser.js";

let tmpDir;
let board;
let baseUrl;
let wsUrl;

function makeTaskRaw(overrides = {}) {
  return serializeTask({
    id: "T-0001",
    title: "External edit",
    status: "backlog",
    priority: "P1",
    phase: 1,
    agent: "infra",
    depends_on: [],
    created: "2026-07-31",
    body: "## Context\n...\n",
    ...overrides
  });
}

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

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-"));
  board = await startBoardServer({ tasksDir: tmpDir, port: 0 });
  const { port } = board.server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws/board`;
});

afterEach(async () => {
  await board.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("board server integration", () => {
  it("broadcasts over /ws/board when a task file is created externally", async () => {
    const client = new WebSocket(wsUrl);
    await waitForOpen(client);

    const messagePromise = waitForMessage(client);
    await fs.writeFile(path.join(tmpDir, "T-0001.md"), makeTaskRaw(), "utf8");

    const event = await messagePromise;
    expect(event.type).toBe("added");
    expect(event.id).toBe("T-0001");
    expect(event.task.title).toBe("External edit");

    client.close();
  });

  it("broadcasts when an externally-created task is then edited on disk", async () => {
    const client = new WebSocket(wsUrl);
    await waitForOpen(client);

    const firstEvent = waitForMessage(client);
    await fs.writeFile(path.join(tmpDir, "T-0001.md"), makeTaskRaw(), "utf8");
    await firstEvent;

    const secondEvent = waitForMessage(client);
    await fs.writeFile(path.join(tmpDir, "T-0001.md"), makeTaskRaw({ title: "Renamed" }), "utf8");
    const event = await secondEvent;

    expect(event.type).toBe("changed");
    expect(event.task.title).toBe("Renamed");

    client.close();
  });

  it("still serves the REST API on the same server", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("refuses to start on any host other than 127.0.0.1", async () => {
    await expect(
      startBoardServer({ tasksDir: tmpDir, port: 0, host: "0.0.0.0" })
    ).rejects.toThrow(/127\.0\.0\.1/);
  });

  it("is bound to 127.0.0.1", () => {
    expect(board.server.address().address).toBe("127.0.0.1");
  });
});

describe("pty terminal integration", () => {
  it("serves a working shell over /ws/pty on the same server", async () => {
    const { port } = board.server.address();
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/pty`);
    await waitForOpen(client);

    const messages = [];
    const gotHello = new Promise((resolve) => {
      client.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        if (msg.type === "data" && msg.data.includes("integration-hello")) {
          resolve();
        }
      });
    });

    client.send(JSON.stringify({ type: "input", data: "echo integration-hello\n" }));
    await gotHello;

    expect(board.ptyBridge.sessions.size).toBe(1);
    client.close();

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(board.ptyBridge.sessions.size).toBe(0);
  });
});
