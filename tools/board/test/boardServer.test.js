import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { startBoardServer } from "../src/server/boardServer.js";
import { serializeTask } from "../src/lib/taskParser.js";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { DbTaskStore } from "../src/lib/db/dbTaskStore.js";
import { IdAllocatorDb } from "../src/lib/db/idAllocatorDb.js";

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

  it("logs and survives a TaskWatcher 'error' event instead of crashing on an unhandled rejection", async () => {
    // EventEmitter throws synchronously when an 'error' event has no listener -- if boardServer
    // ever stopped wiring one up, this emit would throw here rather than being logged.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    board.watcher.emit("error", new Error("Task file is missing frontmatter delimiters (--- ... ---)"));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("TaskWatcher error"),
      expect.stringContaining("missing frontmatter delimiters")
    );
    warnSpy.mockRestore();
  });
});

describe("board server task store selection (BOARD_TASK_STORE)", () => {
  it("defaults to FsTaskStore when unset -- Phase 1 of cards-to-database changes nothing live", () => {
    expect(board.store).toBeInstanceOf(FsTaskStore);
    expect(board.idAllocator).toBeInstanceOf(IdAllocator);
  });

  it("uses FsTaskStore when taskStoreKind is explicitly 'fs'", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-store-fs-"));
    const server = await startBoardServer({ tasksDir: dir, port: 0, taskStoreKind: "fs" });
    try {
      expect(server.store).toBeInstanceOf(FsTaskStore);
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("uses DbTaskStore when taskStoreKind is 'db', without touching FsTaskStore's tasksDir", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-store-db-"));
    const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-store-dbfile-"));
    const priorBoardDbPath = process.env.BOARD_DB_PATH;
    process.env.BOARD_DB_PATH = path.join(dbDir, "board.db");
    try {
      const server = await startBoardServer({ tasksDir: dir, port: 0, taskStoreKind: "db" });
      try {
        expect(server.store).toBeInstanceOf(DbTaskStore);
        expect(server.idAllocator).toBeInstanceOf(IdAllocatorDb);
        await server.store.create({
          id: "T-0001",
          title: "Db-mode task",
          status: "backlog",
          priority: "P1",
          phase: 1,
          agent: "infra",
          depends_on: [],
          created: "2026-08-07",
          branch: null,
          commit: null,
          pr: null,
          deliverable_type: "code",
          attempts: 0,
          comments: [],
          attachments: [],
          body: ""
        });
        expect(await server.store.get("T-0001")).toMatchObject({ title: "Db-mode task" });
        // fs tasksDir was never touched -- nothing writes card files in db mode
        expect(await fs.readdir(dir)).toEqual([]);
      } finally {
        await server.close();
      }
    } finally {
      if (priorBoardDbPath === undefined) delete process.env.BOARD_DB_PATH;
      else process.env.BOARD_DB_PATH = priorBoardDbPath;
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(dbDir, { recursive: true, force: true });
    }
  });

  it("does not start a TaskWatcher in db mode -- there is no tasks/*.md to watch", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-store-nowatcher-"));
    const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-store-nowatcher-db-"));
    const priorBoardDbPath = process.env.BOARD_DB_PATH;
    process.env.BOARD_DB_PATH = path.join(dbDir, "board.db");
    try {
      const server = await startBoardServer({ tasksDir: dir, port: 0, taskStoreKind: "db" });
      try {
        expect(server.watcher).toBeNull();
      } finally {
        await server.close();
      }
    } finally {
      if (priorBoardDbPath === undefined) delete process.env.BOARD_DB_PATH;
      else process.env.BOARD_DB_PATH = priorBoardDbPath;
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(dbDir, { recursive: true, force: true });
    }
  });

  it("broadcasts a card write over /ws/board in db mode without any tasks/*.md file ever being written", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-store-dbbroadcast-"));
    const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-store-dbbroadcast-db-"));
    const priorBoardDbPath = process.env.BOARD_DB_PATH;
    process.env.BOARD_DB_PATH = path.join(dbDir, "board.db");
    try {
      const server = await startBoardServer({ tasksDir: dir, port: 0, taskStoreKind: "db" });
      try {
        const { port } = server.server.address();
        const client = new WebSocket(`ws://127.0.0.1:${port}/ws/board`);
        await waitForOpen(client);

        const messagePromise = waitForMessage(client);
        const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Db broadcast card", phase: 1 })
        });
        const task = await res.json();

        const event = await messagePromise;
        expect(event.type).toBe("added");
        expect(event.id).toBe(task.id);
        expect(event.task.title).toBe("Db broadcast card");
        expect(await fs.readdir(dir)).toEqual([]);

        client.close();
      } finally {
        await server.close();
      }
    } finally {
      if (priorBoardDbPath === undefined) delete process.env.BOARD_DB_PATH;
      else process.env.BOARD_DB_PATH = priorBoardDbPath;
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(dbDir, { recursive: true, force: true });
    }
  });

  it("rejects an unrecognized BOARD_TASK_STORE value", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-store-bad-"));
    try {
      await expect(
        startBoardServer({ tasksDir: dir, port: 0, taskStoreKind: "postgres" })
      ).rejects.toThrow(/Unknown BOARD_TASK_STORE/i);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("orphaned run recovery", () => {
  it("resets a card stranded at in-progress by a previous process on the next startup", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-reaper-"));
    await fs.writeFile(
      path.join(dir, "T-0050.md"),
      makeTaskRaw({ id: "T-0050", status: "in-progress", title: "Stranded card" }),
      "utf8"
    );

    const reaperBoard = await startBoardServer({ tasksDir: dir, port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${reaperBoard.server.address().port}/api/tasks`);
      const tasks = await res.json();
      const task = tasks.find((t) => t.id === "T-0050");

      expect(task.status).toBe("blocked");
      expect(task.body).toMatch(/## Recovered \(.+\)/);
    } finally {
      await reaperBoard.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves a card at review/done/backlog untouched on startup", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-reaper-"));
    await fs.writeFile(
      path.join(dir, "T-0051.md"),
      makeTaskRaw({ id: "T-0051", status: "review", title: "Awaiting review" }),
      "utf8"
    );

    const reaperBoard = await startBoardServer({ tasksDir: dir, port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${reaperBoard.server.address().port}/api/tasks`);
      const tasks = await res.json();
      const task = tasks.find((t) => t.id === "T-0051");

      expect(task.status).toBe("review");
    } finally {
      await reaperBoard.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("auto-pull poller wiring", () => {
  it("constructs an auto-pull poller wired to the orchestrator and restart coordinator, exposed on the returned board object", () => {
    expect(board.autoPullPoller).toBeDefined();
    expect(typeof board.autoPullPoller.tick).toBe("function");
    expect(typeof board.autoPullPoller.start).toBe("function");
    expect(typeof board.autoPullPoller.stop).toBe("function");
  });

  it("stops the auto-pull poller's timer when the board server closes", async () => {
    const stopSpy = vi.spyOn(board.autoPullPoller, "stop");

    await board.close();
    // afterEach also calls board.close() -- idempotent, matches every other .close() in this file.

    expect(stopSpy).toHaveBeenCalled();
  });

  it("is disabled end-to-end when BOARD_AUTOPULL is set to a disable value", async () => {
    const prior = process.env.BOARD_AUTOPULL;
    process.env.BOARD_AUTOPULL = "0";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-autopull-disabled-"));
    try {
      const server = await startBoardServer({ tasksDir: dir, port: 0 });
      try {
        expect(server.autoPullPoller.enabled).toBe(false);
      } finally {
        await server.close();
      }
    } finally {
      if (prior === undefined) delete process.env.BOARD_AUTOPULL;
      else process.env.BOARD_AUTOPULL = prior;
      await fs.rm(dir, { recursive: true, force: true });
    }
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
