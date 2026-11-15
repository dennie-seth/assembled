import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

// Every path to `done` (a PATCH, a comment-approval, and now the merge reconciler below) ends
// in httpApi.js's applyTerminalStatusEffects, which fire-and-forgets a REAL `pullDevelop` --
// `git fetch origin develop` + a merge -- against whatever `repoRoot` it's given. boardServer.js
// always wires that to this process's own REPO_ROOT (the actual worktree this test file lives
// in), so leaving it real here would mean every test that reaches `done` fires a real network
// git operation against this checkout's own branch. Only `pullDevelop` is faked (same technique
// `httpApi.done.test.js` already uses) -- every other gitOps export (commitTaskFile, etc.) stays
// real, since nothing else in this file depends on faking them.
vi.mock("../src/runner/gitOps.js", async () => {
  const actual = await vi.importActual("../src/runner/gitOps.js");
  return { ...actual, pullDevelop: vi.fn().mockResolvedValue({ advanced: false, before: "x", after: "x" }) };
});

import { pullDevelop } from "../src/runner/gitOps.js";
import { startBoardServer } from "../src/server/boardServer.js";
import { serializeTask } from "../src/lib/taskParser.js";
import { FsTaskStore } from "../src/lib/fsTaskStore.js";
import { IdAllocator } from "../src/lib/idAllocator.js";
import { DbTaskStore } from "../src/lib/db/dbTaskStore.js";
import { IdAllocatorDb } from "../src/lib/db/idAllocatorDb.js";
import { recordAttemptUsage, readAttemptUsage } from "../src/runner/usageLedger.js";
import { reserveLaunchSlot, listActiveReservations } from "../src/runner/launchReservation.js";
import { writeRunState } from "../src/runner/runState.js";
import { rmTemp } from "./helpers/rmTemp.js";

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
  await rmTemp(tmpDir);
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
      await rmTemp(dir);
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
      await rmTemp(dir);
      await rmTemp(dbDir);
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
      await rmTemp(dir);
      await rmTemp(dbDir);
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
      await rmTemp(dir);
      await rmTemp(dbDir);
    }
  });

  it("rejects an unrecognized BOARD_TASK_STORE value", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-store-bad-"));
    try {
      await expect(
        startBoardServer({ tasksDir: dir, port: 0, taskStoreKind: "postgres" })
      ).rejects.toThrow(/Unknown BOARD_TASK_STORE/i);
    } finally {
      await rmTemp(dir);
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
      await rmTemp(dir);
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
      await rmTemp(dir);
    }
  });
});

describe("launch reservation reconciliation on startup (WIP gate T-D)", () => {
  it("releases a dangling reservation left by a previous process's crash", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-reservation-"));
    await fs.writeFile(
      path.join(dir, "T-0060.md"),
      makeTaskRaw({ id: "T-0060", status: "blocked", title: "Crashed mid-launch" }),
      "utf8"
    );
    const runsDir = path.join(dir, ".runs");
    await reserveLaunchSlot({
      runsDir,
      cardId: "T-0060",
      executionId: "exec-crashed",
      invocationId: "inv-crashed",
      owner: "cardLaunch:T-0060",
      reservedCostUsd: 3
    });
    expect(await listActiveReservations({ runsDir })).toHaveLength(1);

    const reconcileBoard = await startBoardServer({ tasksDir: dir, port: 0 });
    try {
      expect(await listActiveReservations({ runsDir })).toHaveLength(0);
    } finally {
      await reconcileBoard.close();
      await rmTemp(dir);
    }
  });

  it("leaves a reservation alone whose card is still genuinely in-progress", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-reservation-"));
    await fs.writeFile(
      path.join(dir, "T-0061.md"),
      makeTaskRaw({ id: "T-0061", status: "in-progress", title: "Still running" }),
      "utf8"
    );
    const runsDir = path.join(dir, ".runs");
    // Genuine liveness evidence (a confirmed-alive pid -- this test process's own) so
    // orphanReaper's own startup sweep does not itself reset the card to blocked before the
    // reservation reconciliation below ever gets to see its status.
    await writeRunState({ runsDir, taskId: "T-0061", pid: process.pid, runLogPath: path.join(runsDir, "T-0061-live.jsonl") });
    await reserveLaunchSlot({
      runsDir,
      cardId: "T-0061",
      executionId: "exec-live",
      invocationId: "inv-live",
      owner: "cardLaunch:T-0061",
      reservedCostUsd: 3
    });

    const reconcileBoard = await startBoardServer({ tasksDir: dir, port: 0 });
    try {
      expect(await listActiveReservations({ runsDir })).toHaveLength(1);
    } finally {
      await reconcileBoard.close();
      await rmTemp(dir);
    }
  });

  it("T-0370 follow-up: starts successfully with a malformed lease file in .launch-reservations, logs the problem, and still releases a well-formed dangling lease beside it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-reservation-malformed-"));
    await fs.writeFile(
      path.join(dir, "T-0062.md"),
      makeTaskRaw({ id: "T-0062", status: "blocked", title: "Crashed mid-launch" }),
      "utf8"
    );
    const runsDir = path.join(dir, ".runs");
    await reserveLaunchSlot({
      runsDir,
      cardId: "T-0062",
      executionId: "exec-crashed",
      invocationId: "inv-crashed",
      owner: "cardLaunch:T-0062",
      reservedCostUsd: 3
    });
    await fs.writeFile(path.join(runsDir, ".launch-reservations", "corrupt.reservation.json"), "{trunc", "utf8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let malformedBoard;
    try {
      malformedBoard = await startBoardServer({ tasksDir: dir, port: 0 });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("corrupt.reservation.json"));
      // The well-formed dangling lease is still reconciled even though a malformed one sits beside
      // it -- read its lease file directly, since listActiveReservations itself would still throw
      // with the malformed file left (on purpose) in the pool.
      const leasePath = path.join(runsDir, ".launch-reservations", "T-0062-execexec-crashed-invinv-crashed.reservation.json");
      const leaseOnDisk = JSON.parse(await fs.readFile(leasePath, "utf8"));
      expect(leaseOnDisk.released).toBe(true);
    } finally {
      errorSpy.mockRestore();
      if (malformedBoard) await malformedBoard.close();
      await rmTemp(dir);
    }
  });

  it("T-0370 follow-up: starts successfully when the reservation directory itself can't be listed, and logs the problem", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-reservation-unlistable-"));
    await fs.writeFile(
      path.join(dir, "T-0063.md"),
      makeTaskRaw({ id: "T-0063", status: "blocked", title: "Unreadable pool" }),
      "utf8"
    );
    const runsDir = path.join(dir, ".runs");
    await fs.mkdir(runsDir, { recursive: true });
    // A regular file where the reservation directory should be -- readdir fails with ENOTDIR
    // (not ENOENT), exercising "the directory itself can't be listed" without depending on
    // platform-specific permission bits.
    await fs.writeFile(path.join(runsDir, ".launch-reservations"), "not a directory", "utf8");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let unlistableBoard;
    try {
      unlistableBoard = await startBoardServer({ tasksDir: dir, port: 0 });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      if (unlistableBoard) await unlistableBoard.close();
      await rmTemp(dir);
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
      await rmTemp(dir);
    }
  });
});

describe("auto-launch poller wiring", () => {
  it("constructs an auto-launch poller exposed on the returned board object", () => {
    expect(board.autoLaunchPoller).toBeDefined();
    expect(typeof board.autoLaunchPoller.tick).toBe("function");
    expect(typeof board.autoLaunchPoller.start).toBe("function");
    expect(typeof board.autoLaunchPoller.stop).toBe("function");
  });

  it("is OFF by default, so merging and deploying the code cannot switch it on", () => {
    expect(process.env.AUTO_LAUNCH_ENABLED).toBeUndefined();
    expect(board.autoLaunchPoller.enabled).toBe(false);
  });

  it("stops the auto-launch poller's timer when the board server closes", async () => {
    const stopSpy = vi.spyOn(board.autoLaunchPoller, "stop");

    await board.close();
    // afterEach also calls board.close() -- idempotent, matches every other .close() in this file.

    expect(stopSpy).toHaveBeenCalled();
  });

  it("is enabled end-to-end when AUTO_LAUNCH_ENABLED is set, and its tick finds nothing to launch on an empty board", async () => {
    const prior = process.env.AUTO_LAUNCH_ENABLED;
    process.env.AUTO_LAUNCH_ENABLED = "true";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-autolaunch-enabled-"));
    try {
      const server = await startBoardServer({ tasksDir: dir, port: 0 });
      try {
        expect(server.autoLaunchPoller.enabled).toBe(true);
        // No tasks/.runs directory exists yet on a fresh board, so usage is undetermined and the
        // tick must skip rather than launch -- the fail-safe contract, end to end.
        await expect(server.autoLaunchPoller.tick()).resolves.toBeNull();
      } finally {
        await server.close();
      }
    } finally {
      if (prior === undefined) delete process.env.AUTO_LAUNCH_ENABLED;
      else process.env.AUTO_LAUNCH_ENABLED = prior;
      await rmTemp(dir);
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

describe("usage-ledger drain on shutdown (T-0367 fix round 3)", () => {
  // Before this round, only runCard()'s own `finally` drained pending usage-ledger writes --
  // there was no call site at all for a board-process shutdown (a quota-stop/crash/restart is
  // exactly when a terminal write racing process exit matters most; see docs/usage-telemetry.md).
  const usageKey = (runsDir) => ({
    runsDir,
    cardId: "T-CLOSE-DRAIN",
    executionId: "exec-close-1",
    invocationId: "inv-close-1",
    attempt: 1,
    phase: "implementer",
    retry: 0
  });

  it("drains an in-flight terminal usage write before close() resolves", async () => {
    const runsDir = path.join(tmpDir, ".runs");
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    // Fire-and-forget on purpose, matching how the orchestrator itself dispatches a terminal
    // record (`void this._recordUsage(...)`) -- close() is what's under test for whether it waits.
    recordAttemptUsage({
      ...usageKey(runsDir),
      events: [
        {
          type: "result",
          usage: { input_tokens: 42, output_tokens: 7 },
          total_cost_usd: 0.01
        }
      ],
      outcome: "success",
      complete: true,
      writeFileFn: async (...args) => {
        await gate;
        // A real timing gap between "gate released" and "write actually lands" -- if close()
        // does not itself await the drain, closePromise resolves before this elapses and the
        // assertion below catches it reading a not-yet-written (null) entry.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return fs.writeFile(...args);
      }
    }).catch(() => {});

    const closePromise = board.close();
    release();
    await closePromise;

    const entry = await readAttemptUsage(usageKey(runsDir));
    expect(entry).not.toBeNull();
    expect(entry.tokens.input).toBe(42);
    expect(entry.outcome).toBe("success");
    expect(entry.complete).toBe(true);
  });

  it("a hung usage-ledger drain still lets close() finish within its bound", async () => {
    const localTasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-drain-hang-"));
    const localBoard = await startBoardServer({
      tasksDir: localTasksDir,
      port: 0,
      usageDrainTimeoutMs: 50
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const runsDir = path.join(localTasksDir, ".runs");
    const write = recordAttemptUsage({
      ...usageKey(runsDir),
      events: [{ type: "result", usage: { input_tokens: 5, output_tokens: 1 }, total_cost_usd: 0 }],
      outcome: "success",
      complete: true,
      writeFileFn: async (...args) => {
        await gate; // held past the drain bound below on purpose
        return fs.writeFile(...args);
      }
    });

    const start = Date.now();
    await localBoard.close();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("usage-ledger drain"));

    release();
    await write;
    warnSpy.mockRestore();
    await rmTemp(localTasksDir);
  });

  it("a rejecting usage-ledger drain is logged and never blocks close() or throws", async () => {
    const localTasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-drain-fail-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const localBoard = await startBoardServer({
      tasksDir: localTasksDir,
      port: 0,
      drainPendingUsageWritesFn: async () => {
        throw new Error("simulated drain failure");
      }
    });

    await expect(localBoard.close()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("usage-ledger drain"),
      expect.anything()
    );

    warnSpy.mockRestore();
    await rmTemp(localTasksDir);
  });
});

// T-0434 sat in `review` with its PR already merged because the merge happened while the board
// was down -- a live-event listener alone would have missed it too. These tests exercise the
// actual fix through `startBoardServer` itself (never by calling the reconciler's own methods
// directly, which is the exact gap a prior review round flagged: nothing proved the wiring in
// boardServer.js -- as opposed to the reconciler module in isolation -- actually runs). Each test
// drives a real `gh` invocation through a fake `gh` on PATH, the same technique githubOps.test.js
// uses, so this is a genuine end-to-end path: card file on disk -> startBoardServer -> real
// (faked-transport) `gh pr view` -> card flips to done, observed back through the REST API.
describe("merge reconciler wiring (T-0458) -- recovers a merge missed while the board was down, through startBoardServer itself", () => {
  const FAKE_GH_PR_VIEW = `#!/usr/bin/env bash
set -e
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  cat "$FAKE_GH_STATE/pr-view-result.json"
  exit 0
fi
echo "unknown gh invocation: $@" >&2
exit 1
`;

  let mergeBinDir;
  let mergeStateDir;
  let mergeTmpRoot;
  let originalPath;
  let originalState;
  let envBackup;

  beforeEach(async () => {
    pullDevelop.mockClear();
    mergeTmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-mergewiring-"));
    mergeBinDir = path.join(mergeTmpRoot, "bin");
    mergeStateDir = path.join(mergeTmpRoot, "state");
    await fs.mkdir(mergeBinDir, { recursive: true });
    await fs.mkdir(mergeStateDir, { recursive: true });
    await fs.writeFile(path.join(mergeBinDir, "gh"), FAKE_GH_PR_VIEW, { mode: 0o755 });

    originalPath = process.env.PATH;
    originalState = process.env.FAKE_GH_STATE;
    process.env.PATH = `${mergeBinDir}:${originalPath}`;
    process.env.FAKE_GH_STATE = mergeStateDir;
    envBackup = {};
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    process.env.FAKE_GH_STATE = originalState;
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rmTemp(mergeTmpRoot);
  });

  function setEnv(key, value) {
    if (!(key in envBackup)) envBackup[key] = process.env[key];
    process.env[key] = value;
  }

  async function writeMergedPrFixture({ headRefName }) {
    await fs.writeFile(
      path.join(mergeStateDir, "pr-view-result.json"),
      JSON.stringify({
        url: "https://github.com/example/repo/pull/477",
        state: "MERGED",
        headRefName,
        number: 477
      }),
      "utf8"
    );
  }

  async function waitForTaskStatus(port, id, status, { timeoutMs = 2000, intervalMs = 20 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      const res = await fetch(`http://127.0.0.1:${port}/api/tasks`);
      const tasks = await res.json();
      last = tasks.find((t) => t.id === id);
      if (last && last.status === status) return last;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`timed out waiting for ${id} to reach "${status}" (last seen: ${JSON.stringify(last)})`);
  }

  it("startup reconciliation alone flips a card to done on boot, with the periodic sweep disabled", async () => {
    setEnv("BOARD_MERGE_RECONCILE_SWEEP", "0");
    await writeMergedPrFixture({ headRefName: "feature/T-0477" });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-mergewiring-startup-"));
    await fs.writeFile(
      path.join(dir, "T-0477.md"),
      makeTaskRaw({
        id: "T-0477",
        status: "review",
        title: "Stranded by a merge missed while the board was down",
        branch: "feature/T-0477",
        pr: "https://github.com/example/repo/pull/477"
      }),
      "utf8"
    );

    const mergeBoard = await startBoardServer({ tasksDir: dir, port: 0 });
    try {
      expect(mergeBoard.mergeReconciler.enabled).toBe(true);
      const task = await waitForTaskStatus(mergeBoard.server.address().port, "T-0477", "done");
      expect(task.body).toMatch(/PR .*observed MERGED/);
      // The reconciler is a third route to `done` -- it must fire the exact same terminal-status
      // follow-through (httpApi.js's applyTerminalStatusEffects) the PATCH and comment-approval
      // routes already do, not just write the status field. This is the end-to-end proof: no
      // other code path in this test calls `done` on anything, so a call here can only have come
      // from the reconciler's own wiring through startBoardServer, not from a stub in isolation.
      await vi.waitFor(() => expect(pullDevelop).toHaveBeenCalled());
    } finally {
      await mergeBoard.close();
      await rmTemp(dir);
    }
  });

  it("the periodic sweep alone flips a card to done, with startup reconciliation disabled", async () => {
    setEnv("BOARD_MERGE_RECONCILE_STARTUP", "0");
    setEnv("BOARD_MERGE_RECONCILE_INTERVAL_MS", "30");
    await writeMergedPrFixture({ headRefName: "feature/T-0478" });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-server-mergewiring-sweep-"));
    await fs.writeFile(
      path.join(dir, "T-0478.md"),
      makeTaskRaw({
        id: "T-0478",
        status: "review",
        title: "Stranded by a merge missed while the board was down",
        branch: "feature/T-0478",
        pr: "https://github.com/example/repo/pull/477"
      }),
      "utf8"
    );

    const mergeBoard = await startBoardServer({ tasksDir: dir, port: 0 });
    try {
      // Startup reconciliation is disabled above, so nothing picked this up on boot -- only the
      // periodic sweep (ticking every 30ms here) can be the thing that flips this card to done.
      const task = await waitForTaskStatus(mergeBoard.server.address().port, "T-0478", "done");
      expect(task.body).toMatch(/PR .*observed MERGED/);
      await vi.waitFor(() => expect(pullDevelop).toHaveBeenCalled());
    } finally {
      await mergeBoard.close();
      await rmTemp(dir);
    }
  });
});
