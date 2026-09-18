import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./helpers/rmTemp.js";

/**
 * T-0385 regression, real process. Live incident 2026-09-18: `serviceRestart.js`'s guard
 * correctly logged "develop pulled while a card run is active -- restart deferred until idle"
 * and did not restart -- but the service ran `src/server/index.js` under `node --watch`, which
 * restarted on the pulled files regardless of that guard, dropping the API listener for the
 * rest of the run (see DEPLOY.md). `dev:server` now runs `src/server/watch.js` instead, which
 * applies the same `detectLiveRun` signal `npm run deploy`'s live-run check already uses before
 * ever restarting the watched child. This spawns the real CLI end to end (not the supervisor
 * mocked out, as in watch.test.js/watchSupervisor.test.js) and proves both halves of the
 * contract against a real HTTP listener: a file change while a run looks active never drops
 * `GET /api/health`, and the same change still restarts once the run is gone -- with no further
 * file change needed to notice.
 */

const boardDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fetchHealth(baseUrl) {
  const res = await fetch(`${baseUrl}/api/health`);
  if (!res.ok) throw new Error(`health returned ${res.status}`);
  return res.json();
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fetchHealth(baseUrl);
    } catch {
      // not up yet, or mid-restart -- retry until the deadline
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${baseUrl}/api/health`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

let child;
let tasksDir;
let watchDir;
let repoRootDir;

afterEach(async () => {
  if (child) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  child = undefined;
  await rmTemp(tasksDir);
  await rmTemp(watchDir);
  await rmTemp(repoRootDir);
  tasksDir = undefined;
  watchDir = undefined;
  repoRootDir = undefined;
});

describe.skipIf(process.platform !== "linux")("watch.js: guarded restart on file change (T-0385)", () => {
  it(
    "never drops the API listener for a file change while a run is active, and still restarts once idle",
    async () => {
      const port = 20000 + Math.floor(Math.random() * 20000);
      tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-watchguard-tasks-"));
      watchDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-watchguard-watch-"));
      // Deliberately NOT the real repo root: this test process may itself be a `claude -p`
      // session running under the real checkout, which would otherwise make the guard's
      // pgrep-based liveness check see a "live run" for the entire test regardless of what this
      // test does. Pointing boardDirs at a directory nothing ever runs from means liveness here
      // is driven solely by the tasks/.runs marker file below, same as the "logGrowing" half of
      // liveRunGuard.js's own detectLiveRun.
      repoRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-watchguard-repo-"));
      await fs.mkdir(path.join(tasksDir, ".runs"), { recursive: true });

      child = spawn("node", [path.join(boardDir, "src", "server", "watch.js")], {
        cwd: boardDir,
        env: {
          ...process.env,
          BOARD_PORT: String(port),
          BOARD_TASKS_DIR: tasksDir,
          BOARD_WATCH_PATHS: watchDir,
          BOARD_REPO_ROOT: repoRootDir
        },
        detached: true,
        stdio: "ignore"
      });

      const baseUrl = `http://127.0.0.1:${port}`;
      const initial = await waitForHealth(baseUrl, 10000);

      // Simulate an active card run via the same signal npm run deploy's live-run check uses.
      const runLogPath = path.join(tasksDir, ".runs", "T-FAKE-run.jsonl");
      await fs.writeFile(runLogPath, `{"active":true}\n`);

      // Give chokidar's initial directory scan time to settle before the change we care about.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await fs.writeFile(path.join(watchDir, "probe.js"), "// change while a run is active\n");

      // The listener must keep answering the whole time -- poll across the window instead of a
      // single check at the end, so a restart-then-recover blip would still be caught.
      const activeWindowDeadline = Date.now() + 1500;
      let whileActive = initial;
      while (Date.now() < activeWindowDeadline) {
        whileActive = await fetchHealth(baseUrl);
        expect(whileActive.uptimeSeconds).toBeGreaterThanOrEqual(initial.uptimeSeconds);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      // Now go idle -- the deferred restart fires on its own poll, no further file change needed.
      await fs.rm(runLogPath);

      const restartDeadline = Date.now() + 10000;
      let restarted = false;
      while (Date.now() < restartDeadline) {
        const health = await waitForHealth(baseUrl, 5000);
        if (health.uptimeSeconds < whileActive.uptimeSeconds) {
          restarted = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(restarted).toBe(true);
    },
    30000
  );
});
