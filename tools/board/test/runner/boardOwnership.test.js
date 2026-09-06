// Only ONE process may own a board's database, and only the owner may reap its cards.
//
// The 2026-09-04 incident this pins: T-0304's own agent ran `npx vitest` inside its run. That
// test process inherited BOARD_TASK_STORE=db from the service (claudeCliRunner.js's env
// allowlist), and with no BOARD_DB_PATH set it resolved to DEFAULT_DB_PATH -- the LIVE board
// database. Every test that builds a board server therefore built a second board on the live
// data, with a throwaway tasksDir, and `startBoardServer` calls `orphanReaper.reapOnStartup()`.
// That reaper saw the live in-progress card, found no runstate in ITS empty tmp `.runs` dir,
// verdicted "dead", and reset the card the real board was actively running.
//
// Six reaps that evening, each 1.7-2.0s after a `vitest` invocation in the run log:
//
//   20:45:04.850 vitest -> 20:45:06.749 reap      21:26:26.803 vitest -> 21:26:28.576 reap
//   20:48:41.605 vitest -> 20:48:43.329 reap      21:33:33.965 vitest -> 21:33:35.825 reap
//   21:22:28.744 vitest -> 21:22:30.722 reap      21:36:24.315 vitest -> 21:36:26.030 reap
//
// Neither existing guard could help: #322's ownership check reads the OTHER process's
// `activeCardIds` (empty in a fresh test process), and #336's launch grace is not consulted by
// `reapOnStartup` at all. The defect is cross-process, so the guard has to be cross-process too.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireBoardOwnership, boardOwnerLockPath } from "../../src/runner/boardOwnership.js";

let dir;
let lockPath;

const lines = (logger) => logger.log.mock.calls.map((c) => c.join(" "));
const makeLogger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-owner-"));
  lockPath = path.join(dir, "board.db.owner.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("boardOwnerLockPath", () => {
  it("sits next to the database file it guards", () => {
    expect(boardOwnerLockPath("/var/lib/board/board.db")).toBe("/var/lib/board/board.db.owner.json");
  });
});

describe("acquireBoardOwnership", () => {
  it("acquires an unheld board and records our pid", async () => {
    const res = await acquireBoardOwnership({ lockPath, pid: 4242, isPidAliveFn: () => true });

    expect(res.owned).toBe(true);
    expect(res.heldBy).toBe(null);
    const written = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(written.pid).toBe(4242);
  });

  it("REFUSES a board already held by a different LIVE process -- the incident", async () => {
    await fs.writeFile(lockPath, JSON.stringify({ pid: 975874, acquiredAt: new Date().toISOString() }));

    const res = await acquireBoardOwnership({
      lockPath,
      pid: 111222,
      isPidAliveFn: (pid) => pid === 975874
    });

    expect(res.owned).toBe(false);
    expect(res.heldBy).toBe(975874);
    // the live owner's record must survive untouched
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).pid).toBe(975874);
  });

  it("takes over a stale lock whose owner is dead -- a genuine restart must still reap", async () => {
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999, acquiredAt: "2026-09-04T10:00:00.000Z" }));

    const res = await acquireBoardOwnership({ lockPath, pid: 4242, isPidAliveFn: () => false });

    expect(res.owned).toBe(true);
    expect(res.heldBy).toBe(999);
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).pid).toBe(4242);
  });

  it("re-acquires its own lock (restart-in-place, same pid)", async () => {
    await fs.writeFile(lockPath, JSON.stringify({ pid: 4242, acquiredAt: "2026-09-04T10:00:00.000Z" }));

    const res = await acquireBoardOwnership({ lockPath, pid: 4242, isPidAliveFn: () => true });

    expect(res.owned).toBe(true);
  });

  it("takes over a corrupt lock rather than deadlocking the reaper forever", async () => {
    await fs.writeFile(lockPath, "{ not json");

    const res = await acquireBoardOwnership({ lockPath, pid: 4242, isPidAliveFn: () => true });

    expect(res.owned).toBe(true);
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).pid).toBe(4242);
  });

  it("is LOUD about every outcome -- silence is what let this run for a day", async () => {
    const logger = makeLogger();
    await fs.writeFile(lockPath, JSON.stringify({ pid: 975874 }));

    await acquireBoardOwnership({ lockPath, pid: 111222, isPidAliveFn: () => true, logger });

    expect(lines(logger).some((l) => /board-ownership/.test(l) && /975874/.test(l))).toBe(true);
  });

  it("never throws when the lock directory is unwritable -- ownership must fail SAFE (not owned)", async () => {
    const res = await acquireBoardOwnership({
      lockPath: path.join(dir, "nope", "deeper", "board.db.owner.json"),
      pid: 4242,
      isPidAliveFn: () => true,
      writeFileFn: async () => {
        throw new Error("EACCES");
      }
    });

    expect(res.owned).toBe(false);
  });
});
